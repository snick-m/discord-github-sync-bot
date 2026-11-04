export interface Writer {
  kind: "bridge" | "user";
  discordId?: string;
  githubId?: string;
  login?: string;
}
export interface Relay {
  kind: "thread" | "message";
  sourceId: string;
  writer: Writer;
}
export interface UserAccess {
  token: string;
  githubId: string;
  login: string;
}
export interface Authorship {
  access(
    discordId: string,
    expectedGithubId?: string,
  ): Promise<UserAccess | undefined>;
  invalidate(discordId: string, githubId: string): void;
  sign(relay: Relay, repository: string): string;
  verify(
    body: string,
    githubAuthorId: string,
    repository: string,
  ): Relay | undefined;
}

export class WriteBlocked extends Error {
  constructor(
    readonly discordId: string | undefined,
    readonly reason: "link" | "permission" | "original-author",
    message: string,
  ) {
    super(message);
    this.name = "WriteBlocked";
  }
}
