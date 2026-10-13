/**
 * Turns the editorial profile files into the context given to the model. Each
 * section is labelled with what the model may do with it, so verified facts,
 * opinions and style examples are never confused.
 */

export type ProfileSectionName =
  | 'identity'
  | 'voice'
  | 'facts'
  | 'opinions'
  | 'projects'
  | 'examples'
  | 'rules';

export type ProfileSections = Readonly<Record<ProfileSectionName, string | null>>;

const SECTIONS: readonly { name: ProfileSectionName; heading: string; usage: string }[] = [
  { name: 'identity', heading: 'IDENTITY', usage: 'Who the author is.' },
  {
    name: 'facts',
    heading: 'VERIFIED FACTS',
    usage: 'True statements about the author. Only these may be stated as facts about the author.',
  },
  {
    name: 'projects',
    heading: 'CURRENT PROJECTS',
    usage: 'What the author is building. Respect what may and may not be shared.',
  },
  {
    name: 'opinions',
    heading: 'OPINIONS',
    usage: "The author's actual views. Only these may be presented as the author's opinions.",
  },
  { name: 'voice', heading: 'VOICE AND STYLE', usage: 'How the author writes.' },
  { name: 'rules', heading: 'EDITORIAL RULES', usage: 'Rules every post must follow.' },
  {
    name: 'examples',
    heading: 'POSTS WRITTEN BY THE AUTHOR',
    usage: 'Style references only. Never copy or closely paraphrase them.',
  },
];

/** Removes `<!-- ... -->` comments (guidance for the author, not for the model). */
export function stripMarkdownComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

/** Splits `examples.md` into individual posts (separated by lines containing only `---`). */
export function parseExamplePosts(markdown: string): string[] {
  return stripMarkdownComments(markdown)
    .split(/^\s*---\s*$/m)
    .map((post) => post.trim())
    .filter((post) => post !== '');
}

export function buildProfileContext(sections: ProfileSections): string {
  const blocks: string[] = [];
  for (const { name, heading, usage } of SECTIONS) {
    const raw = sections[name];
    if (raw === null) continue;
    const content =
      name === 'examples'
        ? parseExamplePosts(raw)
            .map((post, index) => `Example ${index + 1}:\n${post}`)
            .join('\n\n')
        : stripMarkdownComments(raw).trim();
    if (content === '') continue;
    blocks.push(`### ${heading}\n(${usage})\n\n${content}`);
  }
  return blocks.join('\n\n');
}
