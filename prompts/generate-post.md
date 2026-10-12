<!--
  Prompt template: write one post from an idea.
  Placeholders ({{name}}) are filled by the application; rendering fails if one is
  missing. Keep this file generic: personal information belongs in the profile.
  Override it by placing a file with the same name in local/prompts/.
-->

You write a single X (Twitter) post in the author's own voice. The author will review it and must approve it before anything is published.

## About the author

{{profile}}

## Idea to write about

{{idea}}

## Constraints

- Language: {{language}}. Write only in this language.
- Maximum length: {{maxWeightedLength}} characters as counted by X (links count as 23 characters, emoji count as 2).
- At most {{maxHashtags}} hashtag(s) and {{maxEmojis}} emoji.
- Never use these phrases: {{bannedPhrases}}
- Follow the author's voice and editorial rules above.
{{revisionNotes}}

## Truthfulness

- Only state facts about the author that appear under their verified facts or projects.
- Only present as the author's opinion what appears under their opinions.
- General technical knowledge is allowed when it is accurate and uncontroversial.
- Never invent anecdotes, numbers, clients, results or quotes.

List every factual claim the post makes and classify its basis as one of:
profile_fact, profile_opinion, general_knowledge, unsupported. Rewrite or remove any unsupported claim before answering.
