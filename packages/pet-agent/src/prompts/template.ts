import { PromptTemplate, renderTemplate } from '@langchain/core/prompts';

export type AgentPromptTemplate<Values extends Record<string, string>> = {
  render(values: Values): string;
};

// Prompt templates are shared by model domains; their variables remain owned
// and derived by each domain.

export function definePromptTemplate<Values extends Record<string, string>>(
  template: string,
  inputVariables: Array<Extract<keyof Values, string>>,
): AgentPromptTemplate<Values> {
  const promptTemplate = new PromptTemplate({
    template,
    inputVariables,
    templateFormat: 'f-string',
    validateTemplate: true,
  });
  const validatedTemplate = promptTemplate.template;
  if (typeof validatedTemplate !== 'string') {
    throw new TypeError('Agent prompt templates must contain text content.');
  }

  return {
    render(values) {
      return renderTemplate(validatedTemplate, 'f-string', values);
    },
  };
}
