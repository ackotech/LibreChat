import { SkillsScope } from 'librechat-data-provider';
import type { SubagentResolveContext } from '@librechat/agents';
import { getLazySubagentConfigId, observeLazySubagentResolution } from './lazySubagents';

const agent = {
  id: 'child-agent',
  name: 'Child',
  description: 'Delegated work',
  provider: 'openAI',
  model: 'gpt-5',
  model_parameters: {
    temperature: 0,
    maxContextTokens: 128000,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
  version: 4,
};

describe('getLazySubagentConfigId', () => {
  it('changes when initializer-relevant config changes', () => {
    const original = getLazySubagentConfigId(agent);
    const changed = getLazySubagentConfigId({
      ...agent,
      instructions: 'Use concise answers.',
    });

    expect(changed).not.toBe(original);
  });

  it('changes when model-advertised identity changes', () => {
    expect(getLazySubagentConfigId({ ...agent, name: 'Renamed child' })).not.toBe(
      getLazySubagentConfigId(agent),
    );
  });

  it('changes when the Git author identity changes', () => {
    expect(
      getLazySubagentConfigId({
        ...agent,
        git_identity: { name: 'First Agent', email: 'first@example.com' },
      }),
    ).not.toBe(
      getLazySubagentConfigId({
        ...agent,
        git_identity: { name: 'Second Agent', email: 'second@example.com' },
      }),
    );
  });

  it('is stable across key order and excludes secret values', () => {
    const first = getLazySubagentConfigId({
      ...agent,
      tool_kwargs: { retry: 2, access_token: 'first-secret' },
    });
    const second = getLazySubagentConfigId({
      ...agent,
      tool_kwargs: { access_token: 'second-secret', retry: 2 },
    });

    expect(second).toBe(first);
  });

  it('includes token-budget settings in the descriptor identity', () => {
    expect(getLazySubagentConfigId({ ...agent, tool_kwargs: { max_tokens: 1024 } })).not.toBe(
      getLazySubagentConfigId({ ...agent, tool_kwargs: { max_tokens: 2048 } }),
    );
  });

  it('includes the persisted version in the descriptor identity', () => {
    expect(getLazySubagentConfigId({ ...agent, version: 5 })).not.toBe(
      getLazySubagentConfigId(agent),
    );
  });

  it('changes when the persisted skill catalog scope changes', () => {
    expect(
      getLazySubagentConfigId({
        ...agent,
        skills_enabled: true,
        skills_scope: SkillsScope.none,
      }),
    ).not.toBe(
      getLazySubagentConfigId({
        ...agent,
        skills_enabled: true,
        skills_scope: SkillsScope.all,
      }),
    );
  });
});

describe('observeLazySubagentResolution', () => {
  function makeContext(signal: AbortSignal): SubagentResolveContext {
    return {
      descriptor: {
        type: 'agent_synthetic',
        name: 'private name',
        description: 'private description',
        configId: 'agent_synthetic:1:abc123',
      },
      executionId: 'execution_synthetic',
      parentRunId: 'run_synthetic',
      parentToolCallId: 'call_synthetic',
      threadId: 'thread_synthetic',
      signal,
      configurable: { requestBody: { messageId: 'private-payload' } },
    };
  }

  it('returns the same result and emits only allowlisted metadata', async () => {
    const context = makeContext(new AbortController().signal);
    const result = { privateResult: 'private-payload' };
    const observe = jest.fn();

    await expect(observeLazySubagentResolution(context, async () => result, observe)).resolves.toBe(
      result,
    );
    expect(observe.mock.calls).toEqual([
      [
        {
          phase: 'config',
          stage: 'started',
          executionId: 'execution_synthetic',
          parentRunId: 'run_synthetic',
          parentToolCallId: 'call_synthetic',
          threadId: 'thread_synthetic',
          descriptorType: 'agent_synthetic',
          configId: 'agent_synthetic:1:abc123',
          aborted: false,
          hasConfigurable: true,
        },
      ],
      [expect.objectContaining({ phase: 'config', stage: 'succeeded', aborted: false })],
    ]);
    expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
  });

  it('rethrows the identical failure and observes the propagated abort', async () => {
    const controller = new AbortController();
    const context = makeContext(controller.signal);
    const failure = new Error('private error');
    const observe = jest.fn();
    const resolve = jest.fn(async () => {
      controller.abort(failure);
      throw context.signal.reason;
    });

    await expect(observeLazySubagentResolution(context, resolve, observe)).rejects.toBe(failure);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'config', stage: 'failed', aborted: true }),
    );
    expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
  });

  it('does not let an observer failure replace success or the original error', async () => {
    const context = makeContext(new AbortController().signal);
    const observer = () => {
      throw new Error('observer failure');
    };
    const result = {};
    const failure = new Error('resolver failure');

    await expect(observeLazySubagentResolution(context, async () => result, observer)).resolves.toBe(
      result,
    );
    await expect(
      observeLazySubagentResolution(context, async () => {
        throw failure;
      }, observer),
    ).rejects.toBe(failure);
  });

  it('omits malformed or oversized identifiers', async () => {
    const context = makeContext(new AbortController().signal);
    context.threadId = 'private payload\n';
    context.parentToolCallId = 'x'.repeat(257);
    const observe = jest.fn();

    await observeLazySubagentResolution(context, async () => undefined, observe);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: undefined, parentToolCallId: undefined }),
    );
  });
});
