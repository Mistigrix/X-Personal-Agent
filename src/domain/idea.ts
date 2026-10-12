export const IDEA_STATUSES = ['new', 'drafted', 'discarded'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
