import * as github from "@actions/github";
import * as core from "@actions/core";

import { getWorkflowRunJobs } from "./github";
import { createTracerProvider, traceWorkflowRunJobs } from "./tracing";
import { getLogsForWorkflowRunJobs, exportLogsToLoki } from "./logging";

export async function run() {
  const ghContext = github.context;
  const otlpEndpoint = core.getInput("otlpEndpoint");
  const otlpHeaders = core.getInput("otlpHeaders");
  const lokiEndpoint = core.getInput("lokiEndpoint");
  const lokiHeaders = core.getInput("lokiHeaders");
  const otelServiceName =
    core.getInput("otelServiceName") || process.env.OTEL_SERVICE_NAME || "";
  const runId = parseInt(core.getInput("runId") || `${ghContext.runId}`);
  const ghToken =
    core.getInput("githubToken") || process.env.GITHUB_TOKEN || "";
  const octokit = github.getOctokit(ghToken);

  core.info(`Get Workflow Run Jobs for ${runId}`);
  const workflowRunJobs = await getWorkflowRunJobs(ghContext, octokit, runId);

  core.info(`Create Trace Provider for ${otlpEndpoint}`);

  const provider = createTracerProvider(
    otlpEndpoint,
    otlpHeaders,
    workflowRunJobs,
    otelServiceName
  );

  try {
    core.info(
      `Trace Workflow Run Jobs for ${runId} and export to ${otlpEndpoint}`
    );
    const spanContext = await traceWorkflowRunJobs({
      provider,
      workflowRunJobs,
    });

    core.info(
      `Loki Logs Workflow Run Jobs for ${runId} and export to ${lokiEndpoint}`
    );
    const lokiLogs = await getLogsForWorkflowRunJobs(
      octokit,
      ghContext.repo,
      runId,
      workflowRunJobs,
      spanContext.traceId
    );
    await exportLogsToLoki(lokiEndpoint, lokiHeaders, lokiLogs);

    core.setOutput("traceId", spanContext.traceId);
  } finally {
    core.info("Shutdown Trace Provider");
    setTimeout(() => {
      provider
        .shutdown()
        .then(() => {
          core.info("Provider shutdown");
        })
        .catch((error: Error) => {
          console.warn(error.message);
        });
    }, 2000);
  }
}
