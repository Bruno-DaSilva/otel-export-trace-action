import {
  WorkflowRunJobs,
  WorkflowRunJob,
  ListJobsForWorkflowRunType,
} from "./github";
import { GitHub } from "@actions/github/lib/utils";
import { Context } from "@actions/github/lib/context";
import axios from "axios";
import * as core from "@actions/core";

type LogStream = {
  github_owner: string;
  github_repo: string;
  github_workflow_id: string;
  github_run_id: string;
  github_run_name: string;
  github_job_id: string;
  github_job_attempt_number: string;
  traceId: string;
};
type LogLine = [timestamp: string, message: string];
type LokiRequestBody = { stream: LogStream; values: LogLine[] };

export async function getWorkflowRunJobsForLogging(
  octokit: InstanceType<typeof GitHub>,
  contextRepo: Context["repo"],
  runId: number
) {
  const jobs: WorkflowRunJob[] = [];
  const pageSize = 100;

  for (let page = 1, hasNext = true; hasNext; page++) {
    const listJobsForWorkflowRunResponse: ListJobsForWorkflowRunType =
      await octokit.rest.actions.listJobsForWorkflowRun({
        ...contextRepo,
        run_id: runId,
        filter: "latest", // risk of missing a run if re-run happens between Action trigger and this query
        page,
        per_page: pageSize,
      });

    jobs.push(...listJobsForWorkflowRunResponse.data.jobs);
    hasNext = jobs.length < listJobsForWorkflowRunResponse.data.total_count;
  }

  return jobs;
}

export async function getLogsForWorkflowRunJobs(
  octokit: InstanceType<typeof GitHub>,
  contextRepo: Context["repo"],
  runId: number,
  workflowRunJobs: WorkflowRunJobs,
  traceId: string
) {
  const logData: LokiRequestBody[] = [];
  for (const job of workflowRunJobs.jobs) {
    const downloadLogsResponse =
      await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        ...contextRepo,
        run_id: runId,
        job_id: job.id,
      });

    const response = await axios({
      method: "get",
      url: downloadLogsResponse.url,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const downloadedLogs = response.data;

    const logLines: string[] = [];
    if (typeof downloadedLogs === "string") {
      logLines.push(...downloadedLogs.split("\n"));
    } else {
      core.setFailed(
        `Error parsing logs response, expected string but got ${typeof downloadedLogs}:`
      );
      console.error(downloadedLogs);
    }

    const parsedLogLines: LogLine[] = [];
    for (const logLine of logLines) {
      // Example log: '2023-06-13T19:09:45.4037197Z Waiting for a runner to pick up this job...'
      // first 28 chars are always the timestamp
      // then a space
      // then the rest is the message
      const timestamp = logLine.substring(0, 28);
      const message = logLine.substring(29);
      parsedLogLines.push([timestamp, message]);
    }

    const stream: LogStream = {
      github_owner: contextRepo.owner,
      github_repo: contextRepo.repo,
      github_workflow_id: workflowRunJobs.workflowRun.workflow_id.toString(),
      github_run_id: workflowRunJobs.workflowRun.id.toString(),
      github_run_name: workflowRunJobs.workflowRun.name || "",
      github_job_id: job.id.toString(),
      github_job_attempt_number:
        (job.run_attempt && job.run_attempt.toString()) || "",
      traceId: traceId,
    };

    const lokiLog: LokiRequestBody = {
      stream,
      values: parsedLogLines,
    };
    logData.push(lokiLog);
  }

  return logData;
}

type StringDict = { [key: string]: string };
function stringToHeader(value: string): StringDict {
  const pairs = value.split(",");
  return pairs.reduce((result, item) => {
    const [key, value] = item.split(": ");
    if (key && value) {
      return {
        ...result,
        [key.trim()]: value.trim(),
      };
    }
    // istanbul ignore next
    return result;
  }, {});
}
export async function exportLogsToLoki(
  lokiEndpoint: string,
  lokiHeaders: string,
  bodies: LokiRequestBody[]
) {
  for (const requestBody of bodies) {
    const jsonBody = JSON.stringify(requestBody);

    const lokiResponse = await axios.post(lokiEndpoint, jsonBody, {
      headers: stringToHeader(lokiHeaders),
    });
    console.log(jsonBody);
    if (lokiResponse.status != 200) {
      console.error(
        `Submitting to loki failed... ${lokiResponse.status} ${lokiResponse.statusText}`
      );
      core.setFailed(`Submitting to loki failed... ${lokiResponse.status}`);
    } else {
      core.info(
        `Submitted logs to loki with status code ${lokiResponse.status}`
      );
    }
  }
}
