import type { InputChannel, UserInput } from "@pftypes/InputChannel.ts";

// ── Input Racer ─────────────────────────────────────────────────────
// Races multiple InputChannels in parallel. The first channel to
// return a response wins. Used to allow users to answer agent
// questions from either CLI stdin or Discord — whichever is faster.

export class InputRacer {
  private readonly channels: ReadonlyArray<InputChannel>;

  constructor(channels: ReadonlyArray<InputChannel>) {
    if (channels.length === 0) {
      throw new Error("InputRacer requires at least one InputChannel");
    }
    this.channels = channels;
  }

  /**
   * Race all channels: prompt each with the question, return the
   * first response received.
   *
   * @param question - The question text to prompt
   * @returns The first response from any channel
   */
  async race(question: string): Promise<UserInput> {
    // Create a never-resolving promise as a sentinel for channels
    // that fail — we don't want a single channel failure to reject
    // the entire race.
    const promises: ReadonlyArray<Promise<UserInput>> = this.channels.map(
      (channel: InputChannel): Promise<UserInput> =>
        channel.prompt(question).catch(
          (): Promise<UserInput> =>
            new Promise<UserInput>((): void => {
              // Never resolves — failed channels are ignored
            }),
        ),
    );

    return Promise.race(promises);
  }

  /**
   * Clean up all channels (close readline, cancel timers, etc.).
   */
  close(): void {
    for (const channel of this.channels) {
      channel.close();
    }
  }
}
