var Command = require('./command');
var Promise = require('promise');
var temp = require('temp').track();
var unzip = require('unzip');
var path = require('path');
var fs = require('fs');
var sax = require('sax');
var debug = require('debug')('mozdevice:util');

var PATHS = {};
PATHS.SYSTEM = '/system';
PATHS.SYSTEM_B2G = '/system/b2g';
PATHS.SETTINGS = 'webapps/settings.gaiamobile.org';
PATHS.B2G_SETTINGS = path.join(PATHS.SYSTEM_B2G, PATHS.SETTINGS);
PATHS.DATA_LOCAL_SETTINGS = path.join('/data/local', PATHS.SETTINGS);
PATHS.APPLICATION_INI = 'application.ini';
PATHS.PLATFORM_INI = 'platform.ini';
PATHS.APPLICATION_ZIP = 'application.zip';
PATHS.SOURCES_XML = 'sources.xml';
PATHS.GAIA_COMMIT = 'resources/gaia_commit.txt';

/**
 * Extract the contents of `zipPath` until `filePath` is found, fetching the
 * contents of `filePath`
 * @param {String} zipPath Location of zip file to extract
 * @param filePath Location of file within zip to read contents
 * @returns {Promise}
 */
var readFileFromZip = function(zipPath, filePath) {
  return new Promise(function(resolve, reject) {
    var fileFound = false;

    fs
      .createReadStream(zipPath)
      .pipe(unzip.Parse())
      .on('close', function() {
        if (!fileFound) {
          reject(new Error('Zip file not found'));
        }
      })
      .on('entry', function(entry) {
        // If this isn't the file we're looking for, drain the contents from
        // memory so we can avoid leaks
        if (entry.path !== filePath) {
          return entry.autodrain();
        }

        fileFound = true;
        resolve(entry);
      })
  });
};

/**
 * Extract a Gecko revision from a device-created XML file
 * @param {String} xmlPath Location of XML file
 * @returns {Promise}
 */
var getGeckoRevisionFromXml = function(xmlPath) {
  var sha;

  return new Promise(function(resolve, reject) {
    var stream = sax.createStream();

    stream.on('opentag', function(node) {
      if (node.name === 'PROJECT' && node.attributes.NAME === 'gecko') {
        sha = node.attributes.REVISION;
        resolve(sha);
      }
    });

    stream.on('end', function() {
      if (!sha) {
        reject(new Error('Unable to find revision in ' + xmlPath));
      }
    });

    fs
      .createReadStream(xmlPath)
      .pipe(stream);
  });
};

/**
 * Extract a Gecko Revision from a device-created INI file
 * @param {String} iniPath Location of INI file
 * @returns {Promise}
 */
var getGeckoRevisionFromIni = function(iniPath) {
  var sha;

  return new Promise(function(resolve, reject) {
    fs
      .createReadStream(iniPath)
      .on('data', function(buffer) {
        buffer
          .toString()
          .split('\n')
          .some(function(line) {
            if (line.indexOf('SourceStamp') === -1) {
              return false;
            }

            sha = line.split('=')[1];
            resolve(sha);
            return true;
          });
      })
      .on('end', function() {
        if (!sha) {
          reject('Unable to find revision in ' + iniPath);
        }
      });
  });
};

/**
 * Extract a Gaia revision from an application.zip file
 * @param {String} baseDir Location of application.zip file
 * @returns {Promise}
 */
var readGaiaCommit = function(baseDir) {
  var zipFile = path.join(baseDir, PATHS.APPLICATION_ZIP);
  var sha;

  return new Promise(function(resolve, reject) {
    readFileFromZip(zipFile, PATHS.GAIA_COMMIT)
      .then(function(stream) {
        stream
          .on('data', function listener(data) {
            if (!sha) {
              sha = data.toString().split('\n')[0];
              stream.removeListener('data', listener);
              resolve(sha);
            }
          })
          .on('close', function() {
            if (!sha) {
              reject(new Error('Unable to find revision in ' + zipFile));
            }
          })
      });
  });
};


/**
 * Miscellaneous utilities for device interaction
 * @param {Device} device
 * @constructor
 */
var Util = function(device) {
  this.serial = device.serial;
};

Util._gaiaRevision = null;
Util._geckoRevision = null;

/**
 * Execute a command against `adb` and fetch the device time at the moment it
 * occurred
 */
Util.prototype.executeWithDeviceTime = function(adbCommand) {
  var serial = this.serial;
  var deviceTimeCommand = new Command()
    .env('ANDROID_SERIAL', serial)
    .adbShell('echo $EPOCHREALTIME')
    .value();

  return new Command()
    .env('DEVICETIME', '$(' + deviceTimeCommand + ')')
    .and()
      .env('ANDROID_SERIAL', serial)
      .adb(adbCommand)
    .and()
      .env('ANDROID_SERIAL', serial)
      .adb('wait-for-device')
    .and()
      .echo('$DEVICETIME')
    .exec()
    .then(function(stdout) {
      // The time generated by EPOCHREALTIME is seconds, we need milliseconds
      return parseFloat(stdout.replace('\n', '')) * 1000;
    });
};

/**
 * Reboot the device and fetch the device time at the moment it occurred
 * @returns {Promise}
 */
Util.prototype.reboot = function() {
  debug('Rebooting');
  return this.executeWithDeviceTime('reboot');
};

/**
 * Start and stop the B2G process on the device and fetch the device time at
 * the moment it occurred
 * @returns {Promise}
 */
Util.prototype.restartB2G = function() {
  debug('Restarting B2G');
  return this.executeWithDeviceTime("shell 'stop b2g && start b2g'");
};

/**
 * Kill a process or application with the specified PID
 * @param {number|string} pid
 * @returns {Promise}
 */
Util.prototype.kill = function(pid) {
  debug('Killing process %d', pid);

  return new Command()
    .env('ANDROID_SERIAL', this.serial)
    .adbShell('kill ' + pid)
    .exec();
};

/**
 * Push a local file to a remote destination on device
 * @param {String} local Path to send to device
 * @param {String} remote Destination on device to receive files from local
 * @returns {Promise}
 */
Util.prototype.push = function(local, remote) {
  return new Command()
    .env('ANDROID_SERIAL', this.serial)
    .adb('push ' + local + ' ' + remote)
    .exec();
};

/**
 * Pull a remote file from the device to a local destination
 * @param {String} remote The remote path to fetch from device
 * @param {String} [local] The local destination to store files from device.
 *                         Defaults to current working direction if not
 *                         specified.
 * @returns {Promise}
 */
Util.prototype.pull = function(remote, local) {
  return new Command()
    .env('ANDROID_SERIAL', this.serial)
    .adb('pull ' + remote + ' ' + (local || process.cwd()))
    .exec();
};

/**
 * Fetch a remote file on device to a local temporary location. Promise resolves
 * with temporary path where file is located.
 * @param {String} remotePath Location of file on device
 * @param {String} file File to pull from `remotePath`
 * @returns {Promise}
 */
Util.prototype.pullToTemp = function(remotePath, file) {
  var util = this;

  return new Promise(function(resolve, reject) {
    temp.mkdir('raptor-temp', function(err, tempDir) {
      if (err) {
        return reject(err);
      }

      var remote = path.join(remotePath, file);
      var local = path.join(tempDir, file);

      util
        .pull(remote, local)
        .then(function() {
          fs.exists(local, function(exists) {
            if (!exists) {
              return reject(new Error('Failed to pull remote file'));
            }

            resolve(tempDir);
          })
        }, reject);
    });
  });
};

/**
 * Pull the Settings application.zip from device
 * @returns {Promise}
 */
Util.prototype.pullApplicationZip = function() {
  var util = this;

  // application.zip could be in one of two different locations on device.
  // Fall back to other location if first failed.
  return new Promise(function(resolve, reject) {
    util
      .pullToTemp(PATHS.B2G_SETTINGS, PATHS.APPLICATION_ZIP)
      .then(resolve, function() {
        util
          .pullToTemp(PATHS.DATA_LOCAL_SETTINGS, PATHS.APPLICATION_ZIP)
          .then(resolve, reject)
      });
  });
};

/**
 * Pull a B2G INI file from device
 * @returns {Promise}
 */
Util.prototype.pullB2GIni = function() {
  var util = this;

  // The B2G INI file is either application.ini or platform.ini. Fall back to
  // secondary location if first fails.
  return new Promise(function(resolve, reject) {
    util
      .pullToTemp(PATHS.SYSTEM_B2G, PATHS.APPLICATION_INI)
      .then(function(tempDir) {
        resolve(path.join(tempDir, PATHS.APPLICATION_INI))
      }, function() {
        util
          .pullToTemp(PATHS.SYSTEM_B2G, PATHS.PLATFORM_INI)
          .then(function() {
            resolve(path.join(tempDir, PATHS.PLATFORM_INI));
          }, reject);
      });
  });
};

/**
 * Fetch the revision of Gecko currently installed on device
 * @returns {Promise}
 */
Util.prototype.getGeckoRevision = function() {
  if (Util._geckoRevision) {
    return Promise.resolve(Util._geckoRevision);
  }

  var util = this;

  // The Gecko revision is either in a sources.xml file or one of a couple INI
  // files. Make sure we try all locations until we have the Gecko revision.
  var promise = new Promise(function(resolve, reject) {
    var pullFromIni = function() {
      return util
        .pullB2GIni()
        .then(getGeckoRevisionFromIni)
        .then(resolve, reject);
    };

    util
      .pullToTemp(PATHS.SYSTEM, PATHS.SOURCES_XML)
      .then(function(tempDir) {
        getGeckoRevisionFromXml(path.join(tempDir, PATHS.SOURCES_XML))
          .then(resolve, pullFromIni);
      }, pullFromIni);
  });

  // Cache the revision for the current session
  promise.then(function(sha) {
    debug('Gecko revision for device: %s', sha);
    Util._geckoRevision = sha;
  });

  return promise;
};

/**
 * Fetch the revision of Gaia currently installed on device
 * @returns {Promise}
 */
Util.prototype.getGaiaRevision = function() {
  if (Util._gaiaRevision) {
    return Promise.resolve(Util._gaiaRevision);
  }

  var promise = this
    .pullApplicationZip()
    .then(readGaiaCommit);

  // Cache the revision for the current session
  promise.then(function(sha) {
    debug('Gaia revision for device: %s', sha);
    Util._gaiaRevision = sha;
  });

  return promise;
};

module.exports = Util;