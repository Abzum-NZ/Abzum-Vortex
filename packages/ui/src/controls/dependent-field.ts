/**
 * A field label inside a sentence: each word that starts with a capital and goes on in lower case
 * ("Account", "Due date") is lowered, while an acronym or a name written in capitals ("SLA",
 * "VAT number") keeps them.
 */
export const labelInSentence = (label: string): string =>
  label.replace(/\b(\p{Lu})(\p{Ll}*)\b/gu, (word, first: string, rest: string) =>
    rest.length > 0 || word.length === 1 ? first.toLowerCase() + rest : word,
  );

/** What a dependent picker shows while its parent is not chosen, in words that name no record. */
export const waitingForParent = (parentLabel: string): string =>
  `Choose ${labelInSentence(parentLabel)} first`;
