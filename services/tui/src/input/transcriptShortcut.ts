export function shouldOpenTranscriptPager(params: {
  key: { name?: string; shift?: boolean };
  composerText: string;
  attachmentCount: number;
}) {
  return params.key.name === 'pageup'
    && !params.key.shift
    && params.composerText.length === 0
    && params.attachmentCount === 0;
}
