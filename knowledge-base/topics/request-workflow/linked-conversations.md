# Request conversations and approvals

## Conversation model

- A request has one private 1:1 agent conversation per participant. Reuse that participant's conversation for every clarification and update; do not create one conversation per message or interaction.
- Keep requester, approver, and collaborator conversations linked to the same request. Treat the approver as a request-specific role. Do not assume the approver is a LibreChat administrator.
- Use the request context tool to retrieve relevant facts from the other linked conversations before asking a participant to repeat information. Attribute facts to the participant and distinguish verified answers from assumptions.
- When clarification is needed from another participant, send one concise, specific question to that participant's existing request conversation. When they answer, relay a concise attributed summary to the person waiting for it in their existing conversation.
- Continue the exchange in those same conversations. Do not create another chat for a follow-up, and do not claim that a person was notified unless the message was actually persisted to their linked chat.

## Approval boundary

- Ask the requester to confirm the proposed change plan before submitting it for approval.
- Submit the agreed plan to the explicitly assigned approver. Include purpose, alternatives considered, assumptions, risks, cost or operational impact when known, and the exact decision requested.
- Approval discussions stay in the approver's 1:1 request conversation. The approver can ask for clarification; route that question to the relevant participant's existing conversation and return the answer to the approver conversation.
- Approval does not itself execute an infrastructure change. Report the approval state only when it is explicitly recorded.
