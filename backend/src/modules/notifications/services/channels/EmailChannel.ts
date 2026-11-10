export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailChannel {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Stand-in for SES/SendGrid/SMTP. Keeps sent mail in memory so tests can
 * assert on it, and can be told to fail so retry behaviour is testable.
 * (SMS and push would be two more implementations of the same idea.)
 */
export class MockEmailChannel implements EmailChannel {
  readonly sent: EmailMessage[] = [];
  private failuresRemaining = 0;

  failNext(times: number) {
    this.failuresRemaining = times;
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Mock email provider unavailable");
    }
    this.sent.push(message);
  }
}

let channel: EmailChannel = new MockEmailChannel();

export function getEmailChannel(): EmailChannel {
  return channel;
}

export function setEmailChannelForTests(c: EmailChannel) {
  channel = c;
}
