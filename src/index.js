const axios = require("axios");
const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const unzipper = require("unzipper");
const os = require("os")


const org = core.getInput('org');
const repo = core.getInput('repo');
const runId = core.getInput('runId');
const workflowName = core.getInput('workflowName');
const workflowPath = core.getInput('workflowPath');
const headBranch = core.getInput('headBranch');
const conclusion = core.getInput('conclusion');
const gitToken = core.getInput('gitToken');
const splunkUrl = core.getInput('splunkUrl');
const splunkHEC = core.getInput('splunkHEC');


/*const org = 'Yog4Prog'
const repo = 'GatesApproval'
const runId = '3673120369'
const workflowName = 'SampleWorkflow';
const workflowPath = '.github/workflows/sample.yml';
const headBranch = 'main';
const conclusion = 'success';
const gitToken = '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'
const splunkUrl = 'https://localhost:8088'
const splunkHEC = 'd58f28c7-2e9b-4270-aefd-455cd886f4aa'*/

async function grabLogsAndUpload() {

    var downloadLogRequest = {
        method: 'get',
        url: `https://api.github.com/repos/${org}/${repo}/actions/runs/${runId}/logs`,
        headers: {
            'Authorization': `Bearer ${gitToken}`,
            'Content-Type': 'application/zip',
            'Accept': 'application/vnd.github.v3+json'
        },
        responseType: 'stream'
    };

    // Delete logs if already downloaded 
    if (fs.existsSync(`${runId}.zip`)) {
        console.log('File exist. Deleting now...')
        fs.unlinkSync(`${runId}.zip`)
    }
    //Delete extracted directory if exists
    if (fs.existsSync(`${runId}`)) {
        console.log('Directory exist. Deleting now...')
        fs.rmSync(`${runId}`, { recursive: true }, err => {
            if (err) {
                throw err
            }
            console.log(`${runId} is deleted!`)
        })
    }

    var resp = await axios(downloadLogRequest)
        .then(async res => {
            const writer = fs.createWriteStream(`${runId}.zip`);
            res.data.pipe(writer);
            res.data.on("end", () => {
                console.log("download completed");
                console.log("Extracting logs....")
                fs.createReadStream(`${runId}.zip`)
                    .pipe(unzipper.Extract({ path: `${runId}` }))
                    .on("close", async () => {
                        console.log("Files unzipped successfully");
                        await uploadLogsToSplunkAsEvent();
                        await uploadLogsToSplunkAsText();
                    });
            });
        })
        .catch(error => {
            console.log("Failed to download workflow logs." + error)
        });
    return true;
}
async function uploadLogsToSplunkAsText() {
    let fileNames = fs.readdirSync(`${runId}`);
    let logs = [];
    var workflow = {
        "workflowId": `${runId}`,
        "workflowName": `${workflowName}`,
        "workflowPath": `${workflowPath}`,
        "headBranch": `${headBranch}`,
        "conclusion": `${conclusion}`
    }
    await fileNames.forEach(async (file) => {
        if (file.endsWith("txt")) {
            console.log(`Logging for ${file}`);
            var lines = fs.readFileSync(`${runId}/${file}`, 'utf-8').split('\n').filter(Boolean);
           
            let log = {
                "job": file.replace(".txt", ""),
                "log": lines.join(""),
            }
            logs.push(log);
        }
    });
    var payload = {
        message: {
            logs,
            workflow
        },
        metadata: {
            source: `${org}/${repo}`,
            sourcetype: "github:git:actions:txt",
            index: "main",
            host: `${os.hostname}`,
        },
        // Severity is also optional
        severity: "info",
       
    }
    makeSplunkRequest(payload);
}

async function uploadLogsToSplunkAsEvent() {
    let fileNames = fs.readdirSync(`${runId}`);
    let timestamp = 0;
    let batch = 0;
    let count = 0;
    let eventMsg = "";
    let t2 = Date.now;
    let events = [];
    await fileNames.forEach(async (file) => {

        if (file.endsWith("txt")) {
            console.log(`Logging for ${file}`);
            count = 0;
            var lines = fs.readFileSync(`${runId}/${file}`, 'utf-8').split('\n').filter(Boolean);
            //console.log(lines);
            let timestampPattern = /\d{4}-\d{2}-\d{2}T\d+:\d+:\d+.\d+Z/;
            lines.forEach(line => {
                count++

                let matches = line.match(timestampPattern)
                if (matches) {
                    timestamp = matches[0];
                    var dt = new Date(timestamp);
                    timestamp = dt.getTime() - new Date("1970-01-01").getTime();
                }
                var fields = {
                    "linenumber": count,
                    "workflowId": `${runId}`,
                    "job": file.replace(".txt", ""),
                    "timestamp": timestamp,
                    "workflowName": `${workflowName}`,
                    "workflowPath": `${workflowPath}`,
                    "headBranch": `${headBranch}`,
                    "conclusion": `${conclusion}`
                }
                let lineSplit = line.split(timestampPattern);
                if (lineSplit.length > 0) {
                    eventMsg = lineSplit[1];
                    if (eventMsg) {
                        batch++;
                        let event = {
                            "event": eventMsg,
                            "fields": fields
                        }
                        events.push(event);
                    }
                }

            })
        }
    })
    var payload = {
        message: {
            events
        },
        metadata: {
            source: `${org}/${repo}`,
            sourcetype: "github:git:actions:json",
            index: "main",
            host: `${os.hostname}`
        },
        // Severity is also optional
        severity: "info"
    }
    makeSplunkRequest(payload);
}

function makeSplunkRequest(payload) {
    var SplunkLogger = require("splunk-logging").Logger;

    var config = {
        token: `${splunkHEC}`,
        url: `${splunkUrl}`
    };

    var Logger = new SplunkLogger(config);

    Logger.send(payload, function (err, resp, body) {
        console.log("Response from Splunk", body);
    });
}
async function main() {
    await grabLogsAndUpload();  
}


main()
