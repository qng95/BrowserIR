import type {
  AgentSubmissionContract,
  AgentToolBroker,
  AgentToolCallResult,
  AgentToolDescriptor,
  AgentToolMetrics,
} from './contracts.js';

export const BENCHMARK_SUBMIT_RESULT_TOOL = 'benchmark_submit_result' as const;

export interface AgentSubmissionState {
  attempts: number;
  submitted: boolean;
  result?: Readonly<Record<string, unknown>> | undefined;
}

export interface SubmissionBrokerHandle {
  broker: AgentToolBroker;
  state(): AgentSubmissionState;
}

class SubmissionBroker implements AgentToolBroker {
  readonly #inner: AgentToolBroker;
  readonly #contract: AgentSubmissionContract | undefined;
  #attempts = 0;
  #errors = 0;
  #result: Readonly<Record<string, unknown>> | undefined;

  constructor(inner: AgentToolBroker, contract: AgentSubmissionContract | undefined) {
    this.#inner = inner;
    this.#contract = contract;
  }

  async listTools(): Promise<readonly AgentToolDescriptor[]> {
    const inner = await this.#inner.listTools();
    if (this.#contract === undefined) return inner;
    if (inner.some((tool) => tool.name === BENCHMARK_SUBMIT_RESULT_TOOL)) {
      throw new Error(`${BENCHMARK_SUBMIT_RESULT_TOOL} is reserved by the benchmark harness.`);
    }
    return [
      ...inner,
      {
        name: BENCHMARK_SUBMIT_RESULT_TOOL,
        title: 'Submit benchmark result',
        description: `${this.#contract.description} Call this exactly once after the browser task is complete.`,
        inputSchema: this.#contract.inputSchema,
      },
    ];
  }

  callTool(name: string, input: Record<string, unknown>): Promise<AgentToolCallResult> {
    if (name !== BENCHMARK_SUBMIT_RESULT_TOOL || this.#contract === undefined) {
      return this.#inner.callTool(name, input);
    }
    this.#attempts += 1;
    if (this.#result !== undefined) {
      this.#errors += 1;
      return Promise.resolve(this.#error('A benchmark result was already submitted.'));
    }
    const validationError = this.#contract.validateInput(input);
    if (validationError !== undefined) {
      this.#errors += 1;
      return Promise.resolve(this.#error(validationError));
    }
    this.#result = structuredClone(input);
    return Promise.resolve({
      text: 'Benchmark result accepted. Stop using tools and finish the run.',
      structuredContent: { accepted: true },
      isError: false,
    });
  }

  metrics(): AgentToolMetrics {
    const inner = this.#inner.metrics();
    if (this.#contract === undefined || this.#attempts === 0) return inner;
    return {
      ...inner,
      calls: inner.calls + this.#attempts,
      errors: inner.errors + this.#errors,
      byTool: {
        ...inner.byTool,
        [BENCHMARK_SUBMIT_RESULT_TOOL]: this.#attempts,
      },
    };
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  state(): AgentSubmissionState {
    return {
      attempts: this.#attempts,
      submitted: this.#result !== undefined,
      ...(this.#result === undefined ? {} : { result: this.#result }),
    };
  }

  #error(message: string): AgentToolCallResult {
    return {
      text: `invalid_submission: ${message}`,
      structuredContent: { error: { code: 'invalid_submission', message } },
      isError: true,
    };
  }
}

export function createSubmissionBroker(
  inner: AgentToolBroker,
  contract?: AgentSubmissionContract,
): SubmissionBrokerHandle {
  const submission = new SubmissionBroker(inner, contract);
  return { broker: submission, state: () => submission.state() };
}
