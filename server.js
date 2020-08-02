'use strict';

require('dotenv').config()
const fs = require('fs');
const express = require('express');
const app = express();
const CronJob = require('cron').CronJob;
const Twit = require('twit');

const config = {
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token: process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
}

let T = new Twit(config);

app.use(express.static('public'));

let listener = app.listen(process.env.PORT, function () {
    console.log('MyHistoryDosis is running on port ' + listener.address().port);

    // every two hours
    (new CronJob('* */2 * * * *', function () {
        var b64content = fs.readFileSync('C:\\Users\\gonza\\Downloads\\unnamed.jpg', { encoding: 'base64' })
        T.post('media/upload', { media_data: b64content }, function (err, data, response) {
            var mediaIdStr = data.media_id_string
            var altText = "Small flowers in a planter on a sunny balcony, blossoming."
            var meta_params = { media_id: mediaIdStr, alt_text: { text: altText } }
            T.post('media/metadata/create', meta_params, function (err, data, response) {
                if (err) {
                    console.log('Error at media/metadata/create: ', err);
                } else {
                    var params = { status: 'loving life #nofilter', media_ids: [mediaIdStr] }
                    T.post('statuses/update', params, function (err, data, response) {
                        if (err) {
                            console.log('Error at statuses/update: ', err);
                        } else {
                            console.log('tweeted', `https://twitter.com/${data.user.screen_name}/status/${data.id_str}`);
                        }
                    })
                }
            })
        })
    })).start();

});