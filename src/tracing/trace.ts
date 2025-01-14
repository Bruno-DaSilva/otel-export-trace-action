import * as core from "@actions/core";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  DiagConsoleLogger,
  DiagLogLevel,
  Exception,
  diag,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { WorkflowRunJobs } from "../github";
import { Resource } from "@opentelemetry/resources";
import {
  setGlobalErrorHandler,
  loggingErrorHandler,
} from "@opentelemetry/core";

const OTEL_CONSOLE_ONLY = process.env.OTEL_CONSOLE_ONLY === "true";

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

export function createTracerProvider(
  otlpEndpoint: string,
  otlpHeaders: string,
  workflowRunJobs: WorkflowRunJobs,
  otelServiceName?: string | null | undefined
) {
  const serviceName =
    otelServiceName ||
    workflowRunJobs.workflowRun.name ||
    `${workflowRunJobs.workflowRun.workflow_id}`;
  const serviceInstanceId = [
    workflowRunJobs.workflowRun.repository.full_name,
    workflowRunJobs.workflowRun.workflow_id,
    workflowRunJobs.workflowRun.id,
    workflowRunJobs.workflowRun.run_attempt,
  ].join("/");
  const serviceNamespace = workflowRunJobs.workflowRun.repository.full_name;
  const serviceVersion = workflowRunJobs.workflowRun.head_sha;

  if (core.isDebug()) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ALL);
  } else {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const provider = new BasicTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: serviceInstanceId,
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: serviceNamespace,
      [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
    }),
  });

  let exporter: SpanExporter = new ConsoleSpanExporter();

  if (!OTEL_CONSOLE_ONLY) {
    exporter = new OTLPTraceExporter({
      url: otlpEndpoint,
      headers: stringToHeader(otlpHeaders),
    });
  }
  // core.debug(JSON.stringify(stringToHeader(otlpHeaders)));

  setGlobalErrorHandler((ex: Exception) => {
    loggingErrorHandler()(ex);
    if (typeof ex === "string") {
      core.setFailed(ex);
    } else {
      core.setFailed(ex.message ?? "no error message, check logs");
    }
  });

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();

  return provider;
}
