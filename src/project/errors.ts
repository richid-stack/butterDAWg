// The error a damaged or unreadable project file raises; its message is written for the person who opens the file.

export class ProjectError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProjectError";
    }
}
