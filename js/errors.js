/* The error a front end shows the user: bad file, missing ROM, a breakpoint outside memory, and so on.
 * It lives apart from the Session so that the parts the Session drives (the debugger) throw the same type
 * without importing the Session. */
export class SessionError extends Error {}
