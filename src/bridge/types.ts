export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  state: "open" | "closed";
  labels: string[];
  locked: boolean;
  createdAt: string;
  own?: boolean;
}
export interface Comment {
  id: string;
  body: string;
  url: string;
  author: string;
  own: boolean;
}
export interface Post {
  id: string;
  title: string;
  starter: Message;
  tags: string[];
  createdAt: string;
  archived?: boolean;
}
export interface Message {
  id: string;
  thread: string;
  body: string;
  url: string;
  author: string;
  bot: boolean;
  own?: boolean;
}
export interface Link {
  issue: number;
  thread: string;
  origin: "github" | "discord";
  starter: string;
  disabled?: boolean;
}
export interface Mirror {
  key: string;
  issue: number;
  origin: "github" | "discord";
  source: string;
  ids: string[];
  hash: string;
}
export type Task =
  | { type: "github"; issue: number }
  | { type: "discord"; thread: string }
  | { type: "state"; issue: number; state: "open" | "closed" }
  | { type: "scan" }
  | { type: "unlink"; thread: string };
export interface Platforms {
  getIssue(number: number): Promise<Issue>;
  issues(since?: string): Promise<Issue[]>;
  createIssue(post: Post, marker: string): Promise<Issue>;
  editIssue(number: number, body: string): Promise<void>;
  state(number: number, state: "open" | "closed"): Promise<void>;
  comments(number: number): Promise<Comment[]>;
  createComment(number: number, body: string): Promise<string>;
  editComment(id: string, body: string): Promise<void>;
  posts(): Promise<Post[]>;
  getPost(thread: string): Promise<Post>;
  createPost(issue: Issue): Promise<Post>;
  updatePost(link: Link, issue: Issue): Promise<void>;
  messages(thread: string): Promise<Message[]>;
  send(thread: string, body: string, nonce: string): Promise<string>;
  edit(thread: string, id: string, body: string): Promise<void>;
}
