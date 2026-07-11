import { PromptTemplate, renderTemplate } from '@langchain/core/prompts';

export type OrchestratorPromptTemplate<Values extends Record<string, string>> = {
  render(values: Values): string;
};

export function definePromptTemplate<Values extends Record<string, string>>(
  template: string,
  inputVariables: Array<Extract<keyof Values, string>>,
): OrchestratorPromptTemplate<Values> {
  const promptTemplate = new PromptTemplate({
    template,
    inputVariables,
    templateFormat: 'f-string',
    validateTemplate: true,
  });
  const validatedTemplate = promptTemplate.template;
  if (typeof validatedTemplate !== 'string') {
    throw new TypeError('Orchestrator prompt templates must contain text content.');
  }

  return {
    render(values) {
      return renderTemplate(validatedTemplate, 'f-string', values);
    },
  };
}
