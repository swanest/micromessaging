export type ConnectionEvents = 'close' | 'error' | 'blocked' | 'unblocked';
export type ChannelEvents = 'close' | 'error' | 'return' | 'drain';
export type OwnEvents =
    'closed' | // Connection has been closed
    'connected' | // Connection has been established
    'timeout' | // Connection handshake timed out
    'unhandledMessage' | // A message arrived but there is no handler to handle it
    'error' | // Connections related errors
    'pressure' |
    'pressureReleased' |
    'leader'
    'unroutableMessage' // Message couldn't be routed and there is no catch
    ;