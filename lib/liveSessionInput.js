// Prior conversation for a new GPT-Live session (session.input at creation).
//
// GPT-Live's voice layer never sees conversation items added after the
// session starts (response.item.create reaches only the delegated backend),
// so after a reload or reconnect Erica's voice started from zero. The
// documented way is "include prior text messages in session.input when you
// create the session" — up to 128 messages and 8,192 combined tokens:
// https://developers.openai.com/api/docs/guides/live-conversations
//
// The list comes from the browser, so it is rebuilt here from role + text
// only: user and assistant messages, nothing else — a client must not be
// able to slip in developer/system messages or other item types.
const MAX_MESSAGES = 128;
// ~8,192 tokens at a conservative 3 chars/token.
const MAX_TOTAL_CHARS = 24000;
const MAX_MESSAGE_CHARS = 4000;

function liveSessionInput(raw) {
    if (!Array.isArray(raw)) return [];
    const messages = [];
    for (const item of raw.slice(-MAX_MESSAGES)) {
        if (!item || typeof item !== 'object') continue;
        const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
        if (!role) continue;
        const parts = Array.isArray(item.content) ? item.content : [];
        const text = parts
            .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
            .join('\n')
            .trim()
            .slice(0, MAX_MESSAGE_CHARS);
        if (!text) continue;
        messages.push({
            type: 'message',
            role,
            content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
        });
    }
    // Oldest first out until the whole list fits.
    let total = messages.reduce((sum, m) => sum + m.content[0].text.length, 0);
    while (messages.length && total > MAX_TOTAL_CHARS) total -= messages.shift().content[0].text.length;
    return messages;
}

module.exports = { liveSessionInput, MAX_MESSAGES, MAX_TOTAL_CHARS };
