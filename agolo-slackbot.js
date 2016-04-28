var validUrl = require('valid-url');
var parseDomain = require('parse-domain');
var RtmClient = require('@slack/client').RtmClient;
var RestClient = require('node-rest-client').Client;

var CLIENT_EVENTS = require('@slack/client').CLIENT_EVENTS;
var RTM_EVENTS = require('@slack/client').RTM_EVENTS;

var BLACKLISTED_SITES = require('./blacklisted-sites.js');

var TOKEN, AGOLO_URL;
var HEROKU = false;

// Determine which environment we're running in
if (process.env.SLACK_TOKEN && process.env.AGOLO_URL) {
	// For Heroku
	TOKEN = process.env.SLACK_TOKEN;
	AGOLO_URL = process.env.AGOLO_URL;
	HEROKU = true;
	
	console.log("Slack token: " + TOKEN);
} else {
	// For local
	var SlackSecret = require('./slack-secrets.js');
	TOKEN = SlackSecret.slackToken();
	AGOLO_URL = SlackSecret.agoloURL();
}

var LOG_LEVEL = 'debug';

var slackClient = new RtmClient(TOKEN, {logLevel: LOG_LEVEL});
var restClient = new RestClient();

var bot; // Track bot user .. for detecting messages by yourself

// Summarize a given URL and call the given callback with the result
var summarize = function(url, typingInterval, callback) {
	var result = "Here's Agolo's summary of " + url + "\n";

	var args = {
		data: {
			"coref":"false",
			"summary_length":"3",
			"articles":[
    			{
					"type":"article",
					"url": url,
					"metadata":{}
				}
			]},
		headers: { "Content-Type": "application/json" }
	};

	console.log("Sending Agolo request!");
	console.log(args);

	restClient.post(AGOLO_URL, args, function (data, rawResponse) {
		console.log("Agolo response: ");
		console.log(data);

		clearInterval(typingInterval);

		if (data && data.summary) {
			for (var summIdx = 0; summIdx < data.summary.length; summIdx++) {
				if (data.summary[summIdx].sentences) {
					var sentences = data.summary[summIdx].sentences;

					console.log("sentences for summary " + summIdx + ": \n", sentences);

					// Quote each line
					for (var i = 0; i < sentences.length; i++) {
						sentences[i] = ">" + sentences[i];
					}

					result = result + sentences.join("\n-\n");

					callback(result);
				}
			}
		}
	});
}

slackClient.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function (rtmStartData) {
	bot = rtmStartData.self.id;
});

slackClient.on('open', function() {
    console.log('Connected');
});

// Make the decision whether to summarize based on a number of factors
var shouldSummarize = function(message, candidate) {
	// Ignore bot's own messages
	if (!message.user || message.user == bot) {
		return false;
	}

	// Possibly just another bot talking to us?
	if (message.is_ephemeral) {
		return false;
	}

	// Is this a real URL?
	if (!validUrl.isWebUri(candidate)) {
		return false;
	}

	// Check our blacklist
	var url = parseDomain(candidate);
	if(BLACKLISTED_SITES[url.subdomain + '.' + url.domain + '.' + url.tld]
		|| BLACKLISTED_SITES[url.subdomain + '.' + url.domain]
		|| BLACKLISTED_SITES[url.domain + '.' + url.tld]
		|| BLACKLISTED_SITES[url.domain]) {
		console.log('Blacklisted site: ', url);
		return false;
	}

	return true;
}

slackClient.on("message", function(message) {
	var text = message.text;
    var channel = message.channel;
    var attachments = message.attachments;

    if (text) {
    	var urlRegex = /<([^\s]+)>/;

    	var matches = text.match(urlRegex);
    	if (matches) {
    		// Start at index 1 because 0 has the entire match, not just the group
    		for (var i = 0; i < matches.length; i++) {
    			var candidate = matches[i];
    			if (shouldSummarize(message, candidate)) {
    				// Show typing indicator as we summarize
    				var sendTypingMessage = function() {
    					slackClient._send({
    						id: 1,
  							type: "typing",
  							channel: channel
						});
    				}
    				var TYPING_MESSAGE_SECS = 3;
    				var typingInterval = setInterval(function() { sendTypingMessage() }, TYPING_MESSAGE_SECS * 1000);
    				

    				summarize(candidate, typingInterval, function(result) {
    					slackClient.sendMessage(result, channel);
    				});
    			}
    		}
    	}

    	var botMentionRegex = /<@([^\s]+)>/;
    	
    	matches = text.match(botMentionRegex);
    	if (matches && matches[1] === bot) {
    		slackClient.sendMessage(':blush:', channel);
    	}
    }
});

slackClient.start();


if (HEROKU) {
	// To prevent Heroku from crashing us. https://github.com/slackhq/node-slack-client/issues/39
	http = require('http');
	handle = function(req, res) {return res.end("hit"); };

	server = http.createServer(handle);

	server.listen(process.env.PORT || 5000);

	if (process.env.HEROKU_APP_URL) {
		var URL = process.env.HEROKU_APP_URL;

		if (URL.indexOf("http") != 0) {
			URL = "http://" + URL;
		}

		console.log("Heroku app URL: " + URL);

		var heartbeat = function() {
			restClient.get(URL, function(){
				console.log("heartbeat!");
			});
		};

		heartbeat();

		var HEARTBEAT_INTERVAL_MINS = 5;
		setInterval(heartbeat, HEARTBEAT_INTERVAL_MINS * 60 * 1000);
	}
}