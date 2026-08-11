export interface SealedUpliftArguments {
  protocolPath: string;
  outputDirectory?: string;
  resumeDirectory?: string;
}

export interface SealedUpliftCommand {
  command: string;
  args: string[];
  cwd: string;
  stdio: 'inherit';
}

export interface SealedUpliftDependencies {
  sourceRoot?: string;
  temporaryParentDirectory?: string;
  runCommand?: (command: SealedUpliftCommand) => Promise<void>;
}

export const SEALED_UPLIFT_USAGE: string;

export function createSealedUpliftEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  isolatedRoot: string,
): Readonly<Record<string, string>>;

export function parseSealedUpliftArguments(args: readonly string[]): SealedUpliftArguments;

export function launchSealedUplift(
  args: readonly string[],
  dependencies?: SealedUpliftDependencies,
): Promise<void>;
