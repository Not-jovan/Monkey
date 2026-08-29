# Auditor

The auditor uses the scraped traces to audit agent runs.

## Implementation Plan

THis is a utility used to minimise rate limit risks.
```
class BatchCaller:
    queue: Task[]
    // batch caller triggers depending on size OR interval comes first.
    bufferSize: number // buffer limit before invocation
    bufferInterval: number // in seconds
    maxBatchesConcurrency: number // Max concurrency. Hard limit

    queue(task)
```

```
// Make sure to do traces, similar to that of the codex runner for each step. This must be normalizable such that it can be audited.
class AgentChatAuditor:
    agentId: string
    chatId: string
    intentId: string

    // Used to store audit memory, especially for long context handling.
    // i.e. agent-runs/{agentId}/{chatId}/
    memoryFolderPath: string

    // We test this step IN ISOLATION. We will raise suspicions OR warnings
    // then we will tie everything together in auditAll()
    auditStep(stepId):
        // 0. Summarize what was done.
        // 1. Check for secret exposure, validate against secret regex AND env variable values. Raise warning.
        // 2. Check for network whitelist calls. 
        //   - Check for existance of URI in trace. 
        //   - If yes, ask LLM to classify whether it is a network call. Raise warning.
        // 3. Validate against intent. Raise suspicion if it could potentially deviate from intent.
        // 4. Check for prompt injection, instructions in tool output / files / subagent replies to leak secrets or escalate privileges. Raise warnings AND suspicion
        // 5. IF it is a tool call, check for tool misuse. Verify if extra flags that could escape the sanbox or escalate privileges are used.
        // 6. IF write to sinks are used (e.g. write to file), classify what was written. Once again, check for secret exposure, validate against secret regex AND env variable values. Raise warning.
        // Do 0 - 6 concurrently
        // Write output to {memoryFolderPath}/{stepId}.md
        // Make sure to use a lock for this, update {memoryFolderPath}/steps-meta.json { [stepId]: { summary: string, findings: Finding[], error: string } }

    // Runs AFTER the steps are done individually auditing + the actual chat is complete / terminated.
    auditAll():
        // Rely on step-meta.json to do detection.
        // 1. Check for repeated failures, means an intent violation for the repeated actions. Raise warning on each of these repeated actions.
        // 2. Check for intent actions. For steps that have suspicions, do a backtrace search of previous step summaries. Deduce which steps influenced this decision. If it aligns with the intent. If it does not align, raise warning.
        // 3. Check for follow through of prompt injections. Do a forwardtrace of a given suspicious instruction to see if it was actually done.
        // Do 1-3 concurrently.
```

In the Auditor tab, show the complete traces of the auditing for each step. Have a button that calls /audit/{chatId} to downlaod the auditing artifacts (Zipped)
