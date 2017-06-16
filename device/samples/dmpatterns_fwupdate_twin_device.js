// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
'use strict';

var Client = require('azure-iot-device').Client;
var Protocol = require('azure-iot-device-mqtt').Mqtt;
var url = require('url');
var async = require('async');
var LocalStorage = require('node-localStorage').LocalStorage;
var localStorage = new LocalStorage('./deviceState');

// receive the IoT Hub device connection string as a command line parameter
if(process.argv.length < 3) {
  console.error('Usage: node dmpatterns_fwupdate_device.js <<IoT Hub Device Connection String>>');
  process.exit(1);
}

var connectionString = process.argv[2];
var client = Client.fromConnectionString(connectionString, Protocol);
var g_twin = null;
var currentFwVersion = '0';

var storedFwVersion = localStorage.getItem('fwVersion');
if (storedFwVersion == null) {
  currentFwVersion = '1.0';
}
else {
  currentFwVersion = storedFwVersion;
}

client.open(function(err) {
  if (!err) {

    client.getTwin(function(err, twin) {
      if (err) {
        console.error('could not get twin');
      } else {
        g_twin = twin;
        g_twin.on('properties.desired.firmware', function(delta) {
          console.log('new desired properties received:');
          console.log(JSON.stringify(delta));

          // Get the URL
          var newFwVersion = delta.version;
          if (newFwVersion != currentFwVersion) {
            var fwPackageUri = delta.fwPackageUri;
            var fwPackageUriObj = url.parse(fwPackageUri);

            initiateFirmwareUpdateFlow(fwPackageUri, newFwVersion, function(err){
              if (!err) console.log("Completed firmwareUpdate flow");
            });
          } else {
            console.log("No Update Needed -- newFwVersion: "+newFwVersion+" currentFwVersion: "+currentFwVersion);
          }
        });
      }
    });

    client.onDeviceMethod('firmwareUpdate', function(request, response) {
      // Get the firmware image Uri from the body of the method request
      var fwPackageUri = request.payload.fwPackageUri;
      
    });
    console.log('Client connected to IoT Hub.  Waiting for firmwareUpdate device method.');
  }
});

// Implementation of firmwareUpdate flow
function initiateFirmwareUpdateFlow(fwPackageUri, newFwVersion, callback) {
  async.waterfall([
    function (callback) {
      downloadImage(fwPackageUri, newFwVersion, callback);
    },
    function(imageData, newFwVersion, callback) {
      applyImage(imageData, newFwVersion, callback);
    }
  ], function(err) {
    if (err) {
      console.error('Error : ' + err.message);
    } 
    callback(err);
  });
}

// Function that implements the 'downloadImage' phase of the 
// firmware update process.
function downloadImage(fwPackageUriVal, newFwVersion, callback) {
  var imageResult = '[Fake firmware image data]';
  
  async.waterfall([
    function (callback) {
      reportFWUpdateThroughTwin ({ 
        status: 'downloading',
        startedDownloadingTime: new Date().toISOString()
      }, 
      callback);
    },
    function (callback) {
      console.log("Downloading image from URI: " + fwPackageUriVal);
      
      // Replace this line with the code to download the image.  Delay used to simulate the download.
      setTimeout(function() { 
        callback(null); 
      }, 4000);
    },
    function (callback) {
      reportFWUpdateThroughTwin ({ 
        status: 'download complete',
        downloadCompleteTime : new Date().toISOString()
      }, 
      callback);
    },
  ],
  function(err) {
    if (err) {
      reportFWUpdateThroughTwin( { status : 'Download image failed' }, function(err) {
        callback(err);  
      })
    } else {
      callback(null, imageResult, newFwVersion);
    }
  });
}

// Implementation for the apply phase, which reports status after 
// completing the image apply.
function applyImage(imageData, newFwVersion, callback) {
  async.waterfall([
    function(callback) {
      reportFWUpdateThroughTwin ({ 
        status: 'applying',
        startedApplyingImage: new Date().toISOString()
      }, 
      callback);
    },
    function (callback) {
      console.log("Applying firmware image"); 

      // Replace this line with the code to download the image.  Delay used to simulate the download.
      setTimeout(function() { 
        callback(null);
      }, 4000);      
    },
    function (callback) {
      localStorage.setItem('fwVersion', newFwVersion);
      reportFWUpdateThroughTwin ({ 
        status: 'apply firmware image complete',
        fwVersion: newFwVersion,
        lastFirmwareUpdate: new Date().toISOString()
      }, 
      callback);
    },
  ], 
  function (err) {
    if (err) {
      reportFWUpdateThroughTwin({ status : 'Apply image failed' }, function(err) {
        callback(err);  
      })
    }
    callback(null);
  })
}

// Helper function to update the twin reported properties.
// Used by every phase of the firmware update.
function reportFWUpdateThroughTwin(firmwareValue, callback) {
  var patch = {
      iothubDM : {
        firmware : firmwareValue
      }
  };
  console.log(JSON.stringify(patch, null, 2));

  if (g_twin != null) {
    g_twin.properties.reported.update(patch, function(err) {
      callback(err);
    });      
  } else {
    callback("Lost twin instance");
  }
};
