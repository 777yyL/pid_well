// Internal provider tool syntax is untrusted text, never executable tool data.
export const malformedToolText = (text: string) =>
  /<[^>\n]*DSML|<\|tool_call|<tool_call[\s>]|<function_calls[\s>]/i.test(text);
