/* jshint node: true, esversion: 6 */
'use strict';

/*
 * aar-transform.js: Titanium Android hook to transform Android Archives
 *
 * Copyright (c) 2017, Appcelerator, Inc.  All Rights Reserved.
 * See the LICENSE file for more information.
 */

var AarTransformer = require('appc-aar-tools').AarTransformer;
var async = require('async');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var wrench = require('wrench');

/**
 * Version number to idenfity the data structure of transform results that are
 * passed to the builder instances. This needs to be changed every time the data
 * structure changes to make sure the cache does not pass outdated data.
 *
 * @type {String}
 * @see doTransform method
 */
const HOOK_DATA_VERSION = '1';

/*
 * Constants do identify the type of a builder instance.
 */
const BUILD_VARIANT_MODULE = 'Module';
const BUILD_VARIANT_APP = 'App';

/*
 * Constants to identify where an .aar file comes from. Currently only Titanium
 * modules and projects are able to provide Android Libraries.
 */
const LIBRARY_ORIGIN_CORE = 'Core';
const LIBRARY_ORIGIN_MODULE = 'Module';
const LIBRARY_ORIGIN_PORJECT = 'Project';

exports.cliVersion = '>=3.2';

exports.init = function (logger, config, cli) {
	cli.on('build.pre.compile', {
		post: function(builder, callback) {
			scanProjectAndStartTransform(builder, logger, callback);
		}
	});

	cli.on('build.module.pre.compile', {
		post: function(builder, callback) {
			scanModuleAndStartTransform(builder, logger, callback);
		}
	});
};

/**
 * Scans a project for all available Android Archives and transforms them so
 * they can be used in the build process.
 *
 * Iterates over every module in the project and looks for .aar files inside the
 * module's lib folder. Also checks the project's platform/android folder for
 * additional .aar files.
 *
 * @param {AndroidBuilder} builder Intance of the AndroidBuilder
 * @param {Object} logger Logger to use
 * @param {Function} callback Function to call once the transform is complete
 */
function scanProjectAndStartTransform(builder, logger, callback) {
	var projectAndroidLibraries = [];

	builder.nativeLibModules.forEach(function(moduleInfo) {
		var moduleLibrariesPath = path.join(moduleInfo.modulePath, 'lib');
		if (!fs.existsSync(moduleLibrariesPath)) {
			return;
		}

		fs.readdirSync(moduleLibrariesPath).forEach(function(file) {
			if (/\.aar$/.test(file)) {
				projectAndroidLibraries.push({
					aarPathAndFilename: path.join(moduleLibrariesPath, file),
					originType: LIBRARY_ORIGIN_MODULE,
					moduleInfo: moduleInfo
				});
			}
		});
	});

	var androidPlatformPath = path.join(builder.projectDir, 'platform', 'android');
	if (fs.existsSync(androidPlatformPath)) {
		fs.readdirSync(androidPlatformPath).forEach(function(file) {
			if (/\.aar$/.test(file)) {
				projectAndroidLibraries.push({
					aarPathAndFilename: path.join(androidPlatformPath, file),
					originType: LIBRARY_ORIGIN_PORJECT
				});
			}
		});
	}

	transformAndroidLibraries(projectAndroidLibraries, builder, BUILD_VARIANT_APP, logger, callback);
}

/**
 * Scans a module for all available Android Archives and transforms them so
 * they can be used in the build process.
 *
 * All .aar files inside a module's lib folder will be considered.
 *
 * @param {AndroidModuleBuilder} builder Intance of the AndroidModuleBuilder
 * @param {Object} logger Logger to use
 * @param {Function} callback Function to call once the transform is complete
 */
function scanModuleAndStartTransform(builder, logger, callback) {
	var moduleAndroidLibraries = [];
	fs.readdirSync(builder.projLibDir).forEach(function(file) {
		if (/\.aar/.test(file)) {
			moduleAndroidLibraries.push({
				aarPathAndFilename: path.join(builder.projLibDir, file),
				originType: LIBRARY_ORIGIN_PORJECT
			});
		}
	});
	transformAndroidLibraries(moduleAndroidLibraries, builder, BUILD_VARIANT_MODULE, logger, callback);
}

/**
 * Starts the actual transform process for all .aar files provided.
 *
 * @param {Array} transformTasks Array of task object, containing info about the file to transform
 * @param {AndroidBaseBuilder} builder The current builder instance
 * @param {String} buildVariant One of the BUILD_VARIANT_* constants
 * @param {Object} logger Logger to use
 * @param {Function} callback Function to call once all tasks are complete
 */
function transformAndroidLibraries(transformTasks, builder, buildVariant, logger, callback) {
	if (transformTasks.length === 0) {
		logger.trace('No .aar files to transform');
		return callback();
	}

	var aarOutputPath = path.join(builder.buildIntermediatesDir, 'exploded-aar');

	var cache = new SimpleFileCache(path.join(aarOutputPath, 'state.json'));
	if (cache.has('data-version')) {
		if (cache.get('data-version') !== HOOK_DATA_VERSION) {
			logger.trace('Cache data structure is out of date, flushing current cache data.');
			cache.flush();
		}
	}
	cache.set('data-version', HOOK_DATA_VERSION);

	var libraryHashMap = {};
	var packageNameMap = {};

	logger.trace('Pre-compile hook: Transforming bundled .aar libraries');
	async.eachSeries(transformTasks, function(transformTaskInfo, next) {
		var aarPathAndFilename = transformTaskInfo.aarPathAndFilename;
		async.waterfall([
			/**
			 * Create a hash from the AAR file we are about to transform.
			 *
			 * We use that hash to store the result of the transform in a cache so
			 * we can skip the whole transform process on subsequent builds.
			 *
			 * @param {Function} done Function to call once the hash has been computed
			 */
			function hashFile(done) {
				var hash = crypto.createHash('sha1');
				var fileReadStream = fs.createReadStream(aarPathAndFilename);
				fileReadStream.on('readable', function() {
					var data = fileReadStream.read();
					if (data) {
						hash.update(data);
					} else {
						var finalHash = hash.digest('hex');
						done(null, finalHash);
					}
				});
			},

			/**
			 * If there already is a library with the exact same SHA-256 hash we can safely
			 * skip all others with the same hash
			 *
			 * @param {String} hash SHA-256 hash of a .aar file
			 * @param {Function} done Function to call once the dupe check is complete
			 */
			function skipLibraryIfDuplicate(hash, done) {
				if (!libraryHashMap[hash]) {
					return done(null, hash);
				}

				logger.trace('Skipping ' + aarPathAndFilename.cyan + ' because it is a duplicate of ' + libraryHashMap[hash].aarPathAndFilename.cyan);
				done(new SkipLibraryError());
			},

			/**
			 * Starts the actual transform process.
			 *
			 * This first checks the cache if we have a transform result for the .aar
			 * hash stored from a previous built and if the exploded aar directory is
			 * still present. If that's the case we can skip the transform and use the
			 * existing data.
			 *
			 * Remember to update HOOK_DATA_VERSION constant if the data
			 * structure this method returns changes.
			 *
			 * @param {String} hash SHA-256 hash of the AAR file.
			 * @param {Function} done Function to call once the transform is complete
			 */
			function doTransform(hash, done) {
				if (cache.has(hash)) {
					var cacheData = cache.get(hash);
					if (cacheData.task.aarPathAndFilename === transformTaskInfo.aarPathAndFilename && fs.existsSync(cacheData.explodedPath)) {
						logger.trace(aarPathAndFilename.cyan + ' has not changed since last built, skipping transform task.');
						return done(null, cacheData);
					}
				}

				var transformer = new AarTransformer(logger);
				var transformOptions = {
					aarPathAndFilename: aarPathAndFilename,
					outputPath: aarOutputPath,
				};
				if (buildVariant === BUILD_VARIANT_APP) {
					transformOptions.assetsDestinationPath = builder.buildBinAssetsDir;
				} else if (buildVariant === BUILD_VARIANT_MODULE) {
					transformOptions.sharedLibraryDestinationPath = builder.localJniGenDir;
				}
				transformer.transform(transformOptions, function (err, result) {
					if (err) {
						return done(err);
					}

					var libraryInfo = {
						packageName: result.packageName,
						explodedPath: result.explodedPath,
						jars: result.jars,
						nativeLibraries: result.nativeLibraries,
						sha256: hash,
						task: transformTaskInfo
					};

					done(null, libraryInfo);
				});
			},

			/**
			 * Ensures all libraries use a unique package name.
			 *
			 * Errors out when two libraries have the same package name and prints
			 * a detailed error message with instructions how to resolve this issue.
			 * We have to do this due to the lack of Gradle and therefore no available
			 * dependency resolution.
			 *
			 * @param {Object} libraryInfo The result of the library transform task
			 * @param {Function} done Function to call once the unique pacakge name check is done
			 */
			function ensureUniquePackageName(libraryInfo, done) {
				function formatDupeInfo(dupeLibraryInfo) {
					var infoString = dupeLibraryInfo.task.aarPathAndFilename + ' (hash: ' + dupeLibraryInfo.sha256;
					if (dupeLibraryInfo.task.originType === LIBRARY_ORIGIN_MODULE) {
						infoString += ', origin: Module ' + dupeLibraryInfo.task.moduleInfo.id;
					} else if (dupeLibraryInfo.task.originType === LIBRARY_ORIGIN_PORJECT) {
						infoString += ', origin: Project';
					}
					infoString += ')';

					return infoString;
				}

				var existingLibrary = packageNameMap[libraryInfo.packageName];
				if (existingLibrary) {
					var errorMessage = 'Conflicting Android Libraries with package name "' + libraryInfo.packageName + '" detected:\n';
					errorMessage += '  ' + formatDupeInfo(existingLibrary) + '\n';
					errorMessage += '  ' + formatDupeInfo(libraryInfo) + '\n\n';
					if (existingLibrary.task.originType === LIBRARY_ORIGIN_MODULE && libraryInfo.task.originType === LIBRARY_ORIGIN_MODULE) {
						errorMessage += 'Please either select a version of these modules where the conflicting .aar file is the same or you can try removing the .aar file from one module\'s "lib" folder.';
					} else if (existingLibrary.task.originType === LIBRARY_ORIGIN_PORJECT && libraryInfo.task.originType === LIBRARY_ORIGIN_PORJECT) {
						errorMessage += 'Please either remove the duplicate .aar file or change the package name of one Android Library if possible.';
					} else if (existingLibrary.task.originType === LIBRARY_ORIGIN_PORJECT || libraryInfo.task.originType === LIBRARY_ORIGIN_PORJECT) {
						errorMessage += 'Please make sure the .aar files in your project and the module match or try removing either the one in your project or in the module.';
					}
					// @TODO: Add a link to docs where this issue is described more in detail.

					return done(new Error(errorMessage));
				}

				done(null, libraryInfo);
			},

			/**
			 * Updates the Builder instance with the result from our transform task.
			 *
			 * @param {Object} libraryInfo The result of the library transform task
			 * @param {Function} done Function to call once the builder was updated
			 */
			function updateBuilderWithTransformResult(libraryInfo, done) {
				if (buildVariant === BUILD_VARIANT_MODULE) {
					libraryInfo.jars.forEach(function(jarPathAndFilename) {
						builder.classPaths[jarPathAndFilename] = 1;
					});
				}

				libraryHashMap[libraryInfo.sha256] = libraryInfo;
				packageNameMap[libraryInfo.packageName] = libraryInfo;
				builder.androidLibraries.push(libraryInfo);

				cache.set(libraryInfo.sha256, libraryInfo);

				done();
			}
		], function (err) {
			if (!err || err instanceof SkipLibraryError) {
				return next();
			}

			next(err);
		});
	}, function(err) {
		if (err) {
			return callback(err);
		}

		// Clean up the cache if files were removed
		var hashes = Object.keys(libraryHashMap);
		var unusedKeys = cache.keys().filter((key) => {
			// exlcude our version meta data key from being removed
			if (key === 'data-version') {
				return false;
			}
			return hashes.indexOf(key) === -1;
		});
		unusedKeys.forEach((key) => {
			cache.remove(key);
		});

		cache.persist();

		callback();
	});
}

/**
 * Marker error class for skipping libraries
 */
class SkipLibraryError extends Error {

}

/**
 * A simple file cache that uses a JSON file as it's storage.
 *
 * This cache reads its data from the cache file once and then operates on a
 * in-memory basis. Changes can be persisted to disk by calling the persist()
 * method.
 */
class SimpleFileCache {
	/**
	 * Constructs a new cache and loads any date from the cache file.
	 *
	 * @param {String} cachePathAndFilename Absolute path and filename to the cache file
	 */
	constructor(cachePathAndFilename) {
		this.cachePathAndFilename = cachePathAndFilename;
		try {
			this.data = fs.existsSync(cachePathAndFilename) ? JSON.parse(fs.readFileSync(cachePathAndFilename)) : {};
		} catch (e) {
			fs.unlinkSync(cachePathAndFilename);
			this.data = {};
		}
	}

	/**
	 * Gets an entry from this cache identfied by key.
	 */
	get(key) {
		return this.has(key) ? this.data[key] : null;
	}

	/**
	 * Sets an entry in this cache, overwriting any existing data.
	 *
	 * This only happens in-memory, call the persist() method to make sure the
	 * changes will be persisted to disk.
	 *
	 * @param {String} key Key to idenfitify the data
	 * @param {Object} data The data to store
	 */
	set(key, data) {
		this.data[key] = data;
	}

	/**
	 * Checks if this cache contains an entry for the specified key.
	 *
	 * @param {String} key The key to check for
	 */
	has(key) {
		return this.data.hasOwnProperty(key);
	}

	/**
	 * Returns all keys that are currently in this cache.
	 */
	keys() {
		return Object.keys(this.data);
	}

	/**
	 * Removes the cache entry identified by key from this cache.
	 *
	 * This only happens in-memory, call the persist() method to make sure the
	 * changes will be persisted to disk.
	 *
	 * @param {String} key The key to remove
	 */
	remove(key) {
		if (this.has(key)) {
			delete this.data[key];
		}
	}

	/**
	 * Removes all data from this cache
	 *
	 * This only happens in-memory, call the persist() method to make sure the
	 * changes will be persisted to disk.
	 */
	flush() {
		this.data = {};
	}

	/**
	 * Persists the current state of this cache to disk.
	 */
	persist() {
		var dataToWrite = JSON.stringify(this.data);
		if (!fs.exists(path.dirname(this.cachePathAndFilename))) {
			wrench.mkdirSyncRecursive(path.dirname(this.cachePathAndFilename));
		}
		fs.writeFileSync(this.cachePathAndFilename, dataToWrite);
	}
}
