import type { MockNodeHandler } from '../plan-types';

const MOCK_RESPONSES: string[] = [
  'Based on the provided information, here is a comprehensive analysis...',
  'I have processed your request. Here is the result: everything looks great!',
  'The data has been summarised. Key insights: patterns detected, action recommended.',
  'Task completed. Output generated successfully with high confidence.',
];

export const openAiHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  const { model, prompt } = node.parameters;

  if (!prompt || String(prompt).trim() === '') {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     'Missing required parameter: prompt',
      durationMs: Date.now() - start,
    };
  }

  const selectedModel  = String(model ?? 'gpt-4o-mini');
  const mockContent    = MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)];
  const promptTokens   = Math.max(10, Math.floor(String(prompt).split(' ').length * 1.3));
  const completionTokens = Math.floor(mockContent.split(' ').length * 1.3);

  return {
    nodeId:   node.id,
    nodeName: node.name,
    status:   'success',
    output: {
      model:   selectedModel,
      content: mockContent,
      usage: {
        prompt_tokens:     promptTokens,
        completion_tokens: completionTokens,
        total_tokens:      promptTokens + completionTokens,
      },
      finish_reason: 'stop',
      simulated:     true,
    },
    durationMs: Date.now() - start,
  };
};
