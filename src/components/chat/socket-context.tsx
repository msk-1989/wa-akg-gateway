"use client";

import { createContext, useContext } from "react";
import type { Socket } from "socket.io-client";

type SocketContextValue = {
    getSocket: () => Socket | null;
    joinSession: (sessionId: string) => void;
    isConnected: boolean;
};

const SocketContext = createContext<SocketContextValue>({
    getSocket: () => null,
    joinSession: () => {},
    isConnected: false,
});

export function useSocket() {
    return useContext(SocketContext);
}

/**
 * SocketProvider — no-op implementation.
 *
 * The original WA-AKG uses a custom server with Socket.io for real-time push.
 * In environments without the custom server (standard `next dev`, Vercel, etc.),
 * Socket.io isn't available. This no-op provider prevents the socket.io-client
 * from flooding the network with failed polling requests.
 *
 * Dashboard pages check `isConnected` and fall back to REST API polling when false.
 * All functionality works — just without real-time push (messages update on refresh).
 */
export function SocketProvider({ children }: { children: React.ReactNode }) {
    return (
        <SocketContext.Provider value={{ getSocket: () => null, joinSession: () => {}, isConnected: false }}>
            {children}
        </SocketContext.Provider>
    );
}
