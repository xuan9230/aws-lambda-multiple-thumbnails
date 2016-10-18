// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm')
            .subClass({ imageMagick: true }); // Enable ImageMagick integration.
var util = require('util');

// constants
var MAX_RESOLUTIONS = [
  {
    width: 100,
    height: 100
  }, {
    width: 300,
    height: 300
  }, {
    width: 1280,
    height: 1024
  }
];

// get reference to S3 client
var s3 = new AWS.S3();

exports.handler = function(event, context, callback) {
    // Read options from the event.
    console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
    var srcBucket = event.Records[0].s3.bucket.name;
    // Object key may have spaces or unicode non-ASCII characters.
    var srcKey    =
    decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
    var dstBucket = srcBucket + "-resized";
    var dstKeySmall    = "SMALL-" + srcKey;
    var dstKeyMedium    = "MEDIUM-" + srcKey;
    var dstKeyLarge    = "LARGE-" + srcKey;


    // Sanity check: validate that source and destination are different buckets.
    if (srcBucket == dstBucket) {
        callback("Source and destination buckets are the same.");
        return;
    }

    // Infer the image type.
    var typeMatch = srcKey.match(/\.([^.]*)$/);
    if (!typeMatch) {
        callback("Could not determine the image type.");
        return;
    }
    var imageType = typeMatch[1].toUpperCase();
    if (imageType != "JPG" && imageType != "PNG" && imageType != "JPEG" && imageType != "BMP") {
        callback('Unsupported image type: ${imageType}');
        return;
    }

    // Download the image from S3, transform, and upload to a different S3 bucket.
    async.waterfall([
        function download(next) {
            // Download the image from S3 into a buffer.
            s3.getObject({
                    Bucket: srcBucket,
                    Key: srcKey
                },
                next);
            },
        function transform(response, next) {
            gm(response.Body).size(function(err, size) {
                // Infer the scaling factor to avoid stretching the image unnaturally.
                var scalingFactors = [];
                var resolutions = [];
                var contentType = '';
                for (var i=0; i<3; i++) {
                  scalingFactors.push(Math.min(
                    MAX_RESOLUTIONS[i].width / size.width,
                    MAX_RESOLUTIONS[i].height / size.height,
                    1
                  ));
                  resolutions.push({
                    width: scalingFactors[i] * size.width,
                    height: scalingFactors[i] * size.height,
                  });
                }

                // Transform the image buffer in memory.
                function resize(resolution, callback) {
                  this.resize(resolution.width, resolution.height)
                    .toBuffer(imageType, function(err, buffer) {
                        if (err) {
                            next(err);
                        } else {
                            contentType = response.ContentType;
                            callback(null, buffer);
                        }
                    });
                }

                async.map(resolutions, resize.bind(this), function(err, results) {
                  next(null, contentType, results);
                });

            });
        },
        function upload(contentType, results, next) {
            // Stream the transformed image to a different S3 bucket.
            async.parallel([
              function(callback) {
                s3.putObject({
                  Bucket: dstBucket,
                  Key: dstKeySmall,
                  Body: results[0],
                  ContentType: contentType
                }, callback);
              },
              function(callback) {
                s3.putObject({
                  Bucket: dstBucket,
                  Key: dstKeyMedium,
                  Body: results[1],
                  ContentType: contentType
                }, callback);
              },
              function(callback) {
                s3.putObject({
                  Bucket: dstBucket,
                  Key: dstKeyLarge,
                  Body: results[2],
                  ContentType: contentType
                }, callback);
              }
            ], function(err, results) {
              next;
            });
          }
        ], function (err) {
            if (err) {
                console.error(
                    'Unable to resize ' + srcBucket + '/' + srcKey +
                    ' and upload to ' + dstBucket +
                    ' due to an error: ' + err
                );
            } else {
                console.log(
                    'Successfully resized ' + srcBucket + '/' + srcKey +
                    ' and uploaded to ' + dstBucket
                );
            }

            callback(null, "message");
        }
    );
};
