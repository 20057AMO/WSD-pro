import { readFile, writeFile, listFiles, execCommand, getProjectTree } from './agent-tools';

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

export interface ToolResult {
  name: string;
  args: Record<string, string>;
  output: string;
}

const TOOL_DEFINITIONS = `
You have access to the following tools. Use them by writing XML tags in your response:

<tool name="readFile" path="path/to/file">Read file contents</tool>
<tool name="writeFile" path="path/to/file" content="file content here">Write content to a file</tool>
<tool name="listFiles" path="path/to/directory">List directory contents</tool>
<tool name="execCommand" command="shell command here">Execute a shell command</tool>
<tool name="getProjectTree" path="." maxDepth="3">Show project file tree</tool>

Rules:
- Use ONE tool per response. Write your reasoning first, then the tool tag.
- After the tool executes, its result will be provided. Use it to continue your work.
- Do NOT write files outside the workspace. Paths are relative to the project root.
- Be careful with execCommand — avoid destructive commands.
- If a tool fails, explain why and try an alternative approach.
`;

export function getToolDefinitions(): string {
  return TOOL_DEFINITIONS;
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<tool\s+name="([^"]+)"([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const attrsStr = match[2];
    const args: Record<string, string> = {};

    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      if (attrMatch[1] !== 'name') {
        args[attrMatch[1]] = attrMatch[2];
      }
    }

    calls.push({ name, args });
  }

  return calls;
}

export function executeToolCall(slug: string, call: ToolCall): ToolResult {
  const { name, args } = call;

  try {
    let output: string;

    switch (name) {
      case 'readFile':
        output = readFile(slug, args.path || '');
        break;
      case 'writeFile':
        output = writeFile(slug, args.path || '', args.content || '');
        break;
      case 'listFiles':
        output = listFiles(slug, args.path || '.');
        break;
      case 'execCommand':
        output = execCommand(slug, args.command || 'echo "no command"');
        break;
      case 'getProjectTree':
        output = getProjectTree(slug, parseInt(args.maxDepth || '3', 10));
        break;
      default:
        output = `[Unknown tool: ${name}]`;
    }

    return { name, args, output };
  } catch (err: any) {
    return { name, args, output: `[Tool error: ${err.message || String(err)}]` };
  }
}

export function hasToolCalls(text: string): boolean {
  return /<tool\s+name="/.test(text);
}

export const MAX_TOOL_ITERATIONS = 10;
