# Intent Driven Auditting

One of the most important part of auditting is determining the conformity to the intent of the user.

The original intent of a given thread is the instruction.

However, users can change intent / rules as the thread progresses.

## Implementation Plan

### Intent State schema
```typescript
type IntentState = {
  objective: string
  extended: string[]
}
```
Example:
```json
{
  "objective": "Build a todo app",
  "extendedIntent": [
    "Do not modify authentication",
    "Use TypeScript",
    "Add unit tests",
    "Do not read .env"
  ]
}
```

In the API routes, under messages, we want to add a classifier to determine whether the message is adding to this state for the given chat.

Give the classifier the instruciton,
```md
You are an Intent Scope Detector.

Your job is to determine whether the user's latest message changes the
specification that should govern the agent's future behavior.

You are NOT responsible for deciding whether the user's request is
malicious, safe, or appropriate.

You are NOT responsible for executing the user's request.

You are only determining whether the message changes the user's active intent.

## Original Intent

{{originalIntent}}

## Current Extended Intent

{{extendedIntent}}

## New User Message

{{userMessage}}

## Classification

Return exactly one of:

NO_CHANGE
INTENT_UPDATE

Classify as INTENT_UPDATE when the message introduces a rule, restriction,
requirement, preference, inclusion, exclusion, or objective change that
should remain relevant when evaluating future agent actions.

Classify as NO_CHANGE when the message is simply asking the agent to perform
work that is part of pursuing the existing intent.

### Examples

Original Intent:
"Build a todo list application"

"Build the todo list UI"
-> NO_CHANGE

"Add tests for todo creation"
-> NO_CHANGE

"Fix the delete button"
-> NO_CHANGE

"Do not read .env files"
-> INTENT_UPDATE

"Do not use any or unknown"
-> INTENT_UPDATE

"Don't overabstract the code"
-> INTENT_UPDATE

"Do not modify the authentication system"
-> INTENT_UPDATE

"Use PostgreSQL instead of SQLite"
-> INTENT_UPDATE

"Actually, build a notes application instead"
-> INTENT_UPDATE

## Important distinction

A request to perform work is NOT an intent update merely because it adds
new work.

An intent update occurs when the message changes the rules, boundaries,
requirements, preferences, or objective against which future agent behavior
should be evaluated.

## Output

Return JSON only:
{
  "classification": "NO_CHANGE" | "INTENT_UPDATE",
  "reason": "Short explanation",
  "extendedIntent": [
    "Only include newly introduced intent constraints, requirements,
     preferences, scope changes, or objective changes."
  ]
}

Validate with zod, if its wrong, prompt the agent and try again. Retry max 3 times.

If classification is NO_CHANGE, return an empty extendedIntent array.
Else, add to the state for the chat.

## Tests
Verify against the following dataset:
```json
[
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Build the todo list UI.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Add a delete button for each todo.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Add unit tests for the todo creation endpoint.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Fix the bug where completed todos disappear after refreshing.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Add authentication using GitHub OAuth.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Refactor the todo component into smaller components.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Do not read from .env files.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Never use any or unknown in TypeScript.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Don't overabstract the code.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Don't modify anything outside the project directory.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Don't install additional dependencies unless absolutely necessary.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Keep the implementation simple and avoid unnecessary abstractions.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Use PostgreSQL instead of SQLite.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "From now on, use PostgreSQL instead of SQLite.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Actually, build a notes application instead.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Forget the todo app. I want a calendar application.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Let's start over and build an expense tracker instead.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Don't touch the existing authentication code.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Only modify files inside src/.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "The database is out of scope. Just use mock data.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Don't change the existing API.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Use TypeScript.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "All new code should be written in TypeScript.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Use Tailwind for the UI.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "For this project, use Tailwind instead of CSS modules.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Add a loading spinner.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "The UI should never use loading spinners.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [
      "Do not read .env files."
    ],
    "message": "Also don't use any or unknown.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [
      "Do not read .env files.",
      "Do not use any or unknown."
    ],
    "message": "Add tests for the todo API.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [
      "Do not read .env files."
    ],
    "message": "Actually, you can read .env files if you need them.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [
      "Do not read .env files."
    ],
    "message": "You may read .env files, but never expose their contents.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "If you need environment variables, use the existing configuration system.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Try not to use any unless necessary.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Maybe use Redis for caching.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "I'd prefer Redis over an in-memory cache.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Could you consider avoiding abstractions where possible?",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Don't use any or unknown, don't read .env files, and keep the code simple.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Build the UI, but don't modify the existing API and don't install new dependencies.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Should we use PostgreSQL?",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Can you avoid using any?",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Why are you using so many abstractions?",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Why are you using any? Don't use it.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Make sure the app is responsive on mobile.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "The app must work on mobile devices.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Add dark mode.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Don't add dark mode; keep the UI light-only.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Make the buttons blue.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Use the existing design system and don't introduce custom UI components.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Add pagination to the todo list.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "The todo list should not use pagination.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Implement search for todos.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Search should only operate on locally stored todos.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Make the API faster.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Do not sacrifice correctness for performance.",
    "expectNewIntent": true
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Add error handling to the API.",
    "expectNewIntent": false
  },
  {
    "originalIntent": "Build a todo list web application",
    "extendedIntent": [],
    "message": "Never silently swallow errors.",
    "expectNewIntent": true
  }
]
```