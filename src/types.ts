export interface Paragraph {
  id: string;
  text: string;
  index: number;
}

export interface Chapter {
  id: string;
  title: string;
  href?: string;
  paragraphs: Paragraph[];
}

export interface Book {
  title: string;
  creator: string;
  chapters: Chapter[];
  coverUrl?: string;
}

export type ReaderTheme = "light" | "sepia" | "charcoal" | "night";

export interface TTSConfig {
  voice: string;
  speed: number;
  pitch: number;
}
