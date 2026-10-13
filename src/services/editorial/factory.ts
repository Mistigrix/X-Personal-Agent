import type { StartupConfig } from '../../config/load.ts';
import type { AppDatabase } from '../../db/client.ts';
import { buildProfileContext } from '../../domain/editorial/profile-context.ts';
import type { LlmClient } from '../../integrations/openai/llm-client.ts';
import { createOpenAiClient } from '../../integrations/openai/openai-client.ts';
import type { Clock } from '../../shared/clock.ts';
import type { Logger } from '../../shared/logger.ts';
import { createEditorialService, type EditorialService } from './editorial-service.ts';
import { createPromptTemplates } from './prompts.ts';

/** Builds the editorial engine from the validated configuration (null when AI is disabled). */
export function createEditorialServiceFromConfig(deps: {
  startup: StartupConfig;
  db: AppDatabase;
  clock: Clock;
  logger: Logger;
  /** Replaces the OpenAI client (tests). */
  llm?: LlmClient;
}): EditorialService | null {
  const { env, config, profile, paths } = deps.startup;
  if (!config.ai.enabled || profile === null) return null;
  const apiKey = env.OPENAI_API_KEY;
  if (!deps.llm && !apiKey) return null;

  const llm =
    deps.llm ??
    createOpenAiClient({
      apiKey: apiKey ?? '',
      models: config.ai.models,
      reasoningEffort: config.ai.reasoningEffort,
      timeoutMs: config.ai.requestTimeoutSeconds * 1000,
    });
  const { editorial, publishing } = config;

  return createEditorialService({
    db: deps.db,
    llm,
    prompts: createPromptTemplates({
      promptsDir: paths.promptsDir,
      overridesDir: paths.promptOverridesDir,
    }),
    profile: buildProfileContext(profile.sections),
    clock: deps.clock,
    logger: deps.logger,
    settings: {
      ideasPerRequest: config.ai.ideasPerRequest,
      maxRegenerations: config.ai.maxRegenerations,
      contentMix: editorial.contentMix,
      topicsFocus: editorial.topics.focus,
      defaultLanguage: editorial.languages.default,
      languageGuidance: editorial.languages.guidance,
      lookbackPosts: editorial.checks.lookbackPosts,
      topicCooldownDays: editorial.checks.topicCooldownDays,
      draftRules: {
        text: { maxWeightedLength: publishing.maxWeightedLength, urlPolicy: publishing.urlPolicy },
        bannedPhrases: editorial.bannedPhrases,
        maxHashtags: editorial.hashtags.max,
        maxEmojis: editorial.emojis.max,
        allowedLanguages: editorial.languages.allowed,
        avoidTopics: editorial.topics.avoid,
        nearDuplicateThreshold: editorial.checks.nearDuplicateThreshold,
      },
    },
  });
}
