/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clusterRequest: vi.fn(),
  isLogRequest: vi.fn<(url: string) => boolean>(),
}));

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  clusterAction: vi.fn(),
}));

vi.mock('@kinvolk/headlamp-plugin/lib/ApiProxy', () => ({
  apply: vi.fn(),
  clusterRequest: mocks.clusterRequest,
}));

vi.mock('@kinvolk/headlamp-plugin/lib/Utils', () => ({
  getCluster: () => 'Headlamp',
}));

vi.mock('@headlamp-k8s/ai-ui/parsing/urlParsing', async importOriginal => {
  const actual = await importOriginal<typeof import('@headlamp-k8s/ai-ui/parsing/urlParsing')>();
  return { ...actual, isLogRequest: mocks.isLogRequest };
});

import { handleActualApiRequest } from './clusterActions';

describe('handleActualApiRequest resource links', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import('@headlamp-k8s/ai-ui/parsing/urlParsing')>(
      '@headlamp-k8s/ai-ui/parsing/urlParsing'
    );
    mocks.isLogRequest.mockImplementation(actual.isLogRequest);
  });

  it('uses the collection kind for metadata-wrapped table rows', async () => {
    mocks.clusterRequest.mockResolvedValue({
      kind: 'Table',
      columnDefinitions: [{ name: 'Node' }, { name: 'Status' }, { name: 'Pool' }],
      rows: [
        {
          cells: ['aks-agentpool-000001', 'Ready', 'agentpool'],
          object: {
            kind: 'PartialObjectMetadata',
            metadata: { name: 'aks-agentpool-000001' },
          },
        },
      ],
    });
    const aiManager = { history: [] };

    const result = await handleActualApiRequest(
      '/api/v1/nodes',
      'GET',
      '',
      vi.fn(),
      aiManager,
      '',
      'Headlamp'
    );

    expect(result).toContain(
      'https://headlamp/resource-details?cluster=Headlamp&kind=nodes&resource=aks-agentpool-000001'
    );
    expect(result).not.toContain('kind=PartialObjectMetadata');
  });

  it('extracts the collection kind from namespaced list URLs', async () => {
    mocks.clusterRequest.mockResolvedValue({
      kind: 'Table',
      columnDefinitions: [{ name: 'Name' }, { name: 'Status' }],
      rows: [
        {
          cells: ['test-pod', 'Running'],
          object: {
            kind: 'PartialObjectMetadata',
            metadata: { name: 'test-pod', namespace: 'default' },
          },
        },
      ],
    });

    const result = await handleActualApiRequest(
      '/api/v1/namespaces/default/pods',
      'GET',
      '',
      vi.fn(),
      { history: [] },
      '',
      'Headlamp'
    );

    expect(result).toContain(
      'https://headlamp/resource-details?cluster=Headlamp&kind=pods&resource=test-pod&ns=default'
    );
  });
});

describe('handleActualApiRequest GET redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLogRequest.mockReturnValue(false);
  });

  it('redacts Secret data before pushing the response to history', async () => {
    mocks.clusterRequest.mockResolvedValue({
      kind: 'Secret',
      apiVersion: 'v1',
      metadata: { name: 'db-credentials', namespace: 'default' },
      data: { DATABASE_PASSWORD: 'aHVudGVyMg==', 'tls.key': 'LS0tLXByaXZhdGUta2V5LS0tLQ==' },
      type: 'Opaque',
    });

    const aiManager = { history: [] as Array<{ content: string }> };
    await handleActualApiRequest(
      '/api/v1/namespaces/default/secrets/db-credentials',
      'GET',
      '',
      () => {},
      aiManager,
      'db-credentials'
    );

    const historyContent = aiManager.history.map(entry => entry.content).join('\n');
    expect(historyContent).not.toContain('aHVudGVyMg==');
    expect(historyContent).not.toContain('LS0tLXByaXZhdGUta2V5LS0tLQ==');
    expect(historyContent).toContain('[REDACTED]');
  });

  it('redacts Secret data in SecretList responses (list of secrets)', async () => {
    mocks.clusterRequest.mockResolvedValue({
      kind: 'SecretList',
      apiVersion: 'v1',
      metadata: { resourceVersion: '12345' },
      items: [
        {
          metadata: { name: 'db-credentials', namespace: 'default' },
          data: { DATABASE_PASSWORD: 'aHVudGVyMg==' },
          type: 'Opaque',
        },
      ],
    });

    const aiManager = { history: [] as Array<{ content: string }> };
    await handleActualApiRequest(
      '/api/v1/namespaces/default/secrets',
      'GET',
      '',
      () => {},
      aiManager,
      'secrets'
    );

    const historyContent = aiManager.history.map(entry => entry.content).join('\n');
    expect(historyContent).not.toContain('aHVudGVyMg==');
    expect(historyContent).toContain('[REDACTED]');
  });

  it('redacts credentials in pod log responses', async () => {
    mocks.isLogRequest.mockReturnValue(true);
    mocks.clusterRequest.mockResolvedValue({
      text: async () => 'starting server\npassword: hunter2\ntoken=abc123xyz\nready',
    });

    const onSuccess = vi.fn();
    const aiManager = { history: [] as Array<{ content: string }> };
    const result = await handleActualApiRequest(
      '/api/v1/namespaces/default/pods/my-pod/log',
      'GET',
      '',
      () => {},
      aiManager,
      'my-pod',
      'Headlamp',
      undefined,
      onSuccess
    );

    expect(result).toContain('starting server');
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('abc123xyz');
    expect(result).toContain('[REDACTED]');

    const historyContent = aiManager.history.map(entry => entry.content).join('\n');
    expect(historyContent).toContain('LOGS_BUTTON:');
    expect(historyContent).not.toContain('hunter2');
    expect(historyContent).not.toContain('abc123xyz');
    expect(historyContent).toContain('[REDACTED]');

    expect(onSuccess).toHaveBeenCalledTimes(1);
    const callbackPayload = JSON.stringify(onSuccess.mock.calls[0][0]);
    expect(callbackPayload).not.toContain('hunter2');
    expect(callbackPayload).not.toContain('abc123xyz');
    expect(callbackPayload).toContain('[REDACTED]');
  });

  it('returns a bounded tail of logs for large log outputs', async () => {
    mocks.isLogRequest.mockReturnValue(true);
    const manyLines = Array.from({ length: 150 }, (_, i) => `log line ${i + 1}`).join('\n');
    mocks.clusterRequest.mockResolvedValue({
      text: async () => manyLines,
    });

    const aiManager = { history: [] as Array<{ content: string }> };
    const result = await handleActualApiRequest(
      '/api/v1/namespaces/default/pods/large-pod/log',
      'GET',
      '',
      () => {},
      aiManager,
      'large-pod',
      'Headlamp'
    );

    expect(result).toContain('... [truncated, showing most recent logs] ...');
    expect(result).toContain('log line 150');
    expect(result).not.toContain('log line 1\n');

    // The LOGS_BUTTON entry in history preserves the complete logs for UI inspection
    const historyEntry = aiManager.history[0]?.content || '';
    expect(historyEntry).toContain('LOGS_BUTTON:');
    expect(historyEntry).toContain('log line 1');
    expect(historyEntry).toContain('log line 150');
  });

  it('returns localized fallback message when pod logs are empty', async () => {
    mocks.isLogRequest.mockReturnValue(true);
    mocks.clusterRequest.mockResolvedValue({
      text: async () => '',
    });

    const aiManager = { history: [] as Array<{ content: string }> };
    const result = await handleActualApiRequest(
      '/api/v1/namespaces/default/pods/empty-pod/log',
      'GET',
      '',
      () => {},
      aiManager,
      'empty-pod',
      'Headlamp'
    );

    expect(result).toBe('No logs available for pods "empty-pod" in namespace "default".');
    expect(aiManager.history[0]?.content).toContain(
      'No logs available for pods "empty-pod" in namespace "default".'
    );
  });
});
