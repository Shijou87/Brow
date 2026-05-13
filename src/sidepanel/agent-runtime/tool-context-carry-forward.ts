export interface ToolContextStepLike {
  label: string;
  toolName: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'error';
  inputText?: string;
  resultText?: string;
  errorText?: string;
  description?: string;
}

const TOOL_CONTEXT_STEP_LIMIT = 12;
const TOOL_CONTEXT_INPUT_LIMIT = 320;
const TOOL_CONTEXT_TEXT_LIMIT = 1400;

function truncateText(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeToolContextSnippet(text: string | undefined, max: number): string | undefined {
  const trimmed = text?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return truncateText(trimmed, max);
}

function selectVisibleCompletedSteps(completedSteps: ToolContextStepLike[]): ToolContextStepLike[] {
  let latestSuccessfulStep: ToolContextStepLike | undefined;
  for (let index = completedSteps.length - 1; index >= 0; index -= 1) {
    if (completedSteps[index].status === 'completed') {
      latestSuccessfulStep = completedSteps[index];
      break;
    }
  }
  const selectedSteps = new Set<ToolContextStepLike>();

  if (latestSuccessfulStep) {
    selectedSteps.add(latestSuccessfulStep);
  }
  for (const step of completedSteps) {
    if (step.status === 'error') {
      selectedSteps.add(step);
    }
  }
  if (selectedSteps.size === 0 && completedSteps.length > 0) {
    selectedSteps.add(completedSteps[completedSteps.length - 1]);
  }

  return completedSteps
    .filter((step) => selectedSteps.has(step))
    .slice(-TOOL_CONTEXT_STEP_LIMIT);
}

export function buildToolContextCarryForwardMessage(toolSteps: ToolContextStepLike[]): string | null {
  const completedSteps = toolSteps.filter((step) => step.status === 'completed' || step.status === 'error');
  if (completedSteps.length === 0) return null;

  const visibleSteps = selectVisibleCompletedSteps(completedSteps);
  const sections = visibleSteps.map((step, index) => {
    const inputText = normalizeToolContextSnippet(step.inputText, TOOL_CONTEXT_INPUT_LIMIT);
    const outcomeText = normalizeToolContextSnippet(
      step.status === 'error'
        ? (step.errorText ?? step.resultText ?? step.description)
        : (step.resultText ?? step.description),
      TOOL_CONTEXT_TEXT_LIMIT,
    );

    return [
      `${index + 1}. ${step.label} (${step.toolName}) [${step.status}]`,
      inputText ? `input: ${inputText}` : '',
      outcomeText ? `${step.status === 'error' ? 'error' : 'result'}: ${outcomeText}` : '',
    ].filter(Boolean).join('\n');
  });

  const omittedCount = completedSteps.length - visibleSteps.length;
  return [
    'Previous turn tool-result summary. Treat this as factual carry-forward context from the completed tool execution.',
    ...sections,
    omittedCount > 0 ? `Additional completed tool steps omitted from this summary: ${omittedCount}.` : '',
  ].filter(Boolean).join('\n\n');
}