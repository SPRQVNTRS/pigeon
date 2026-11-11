/**
 * Thrown by createApp (app/models/apps.server.ts) when another app already
 * has the name. Kept apart from the model so code and tests can name it
 * without importing the database.
 */
export class AppNameTakenError extends Error {
  readonly appName: string;

  constructor(appName: string) {
    super(`An app named "${appName}" already exists`);
    this.name = 'AppNameTakenError';
    this.appName = appName;
  }
}
