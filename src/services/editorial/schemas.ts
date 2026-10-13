/**
 * Structured outputs requested from the model. Every field is required (a
 * Structured Outputs constraint); values are validated again after generation.
 */
import { z } from 'zod';
import { CLAIM_BASES } from '../../domain/editorial/checks.ts';

export const PROFILE_REFERENCES = [
  'identity',
  'facts',
  'projects',
  'opinions',
  'voice',
  'examples',
  'rules',
  'general_knowledge',
] as const;

const claimSchema = z.object({
  claim: z.string().describe('A factual statement made by the post, quoted or paraphrased.'),
  basis: z.enum(CLAIM_BASES),
});

export const ideasOutputSchema = z.object({
  ideas: z.array(
    z.object({
      topic: z.string().describe('Short topic, a few words.'),
      angle: z.string().describe('The specific point the post would make.'),
      category: z.string().describe('One of the content mix categories.'),
      language: z.string().describe('Two-letter ISO 639-1 code of the language to write in.'),
      rationale: z.string().describe('Why this fits the author, citing the profile.'),
      profileSections: z.array(z.enum(PROFILE_REFERENCES)),
    }),
  ),
});
export type IdeasOutput = z.infer<typeof ideasOutputSchema>;

export const draftOutputSchema = z.object({
  text: z.string().describe('The exact post text, ready to publish.'),
  language: z.string().describe('Two-letter ISO 639-1 code of the language used.'),
  claims: z.array(claimSchema),
});
export type DraftOutput = z.infer<typeof draftOutputSchema>;

export const evaluationOutputSchema = z.object({
  voice: z.number().describe('1 to 5: sounds like the author.'),
  value: z.number().describe('1 to 5: useful or interesting for the audience.'),
  clarity: z.number().describe('1 to 5: clear and easy to read.'),
  claims: z.array(claimSchema),
  issues: z.array(z.string()),
  recommendation: z.enum(['keep', 'revise', 'discard']),
});
export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;
