/**
 * Mock Socket.io server — provides the same `to(room).emit(event, data)` interface
 * but does nothing. Used when running with standard `next dev` instead of the
 * custom server. Real-time push won't work (clients must poll), but all REST API
 * and dashboard functionality works normally.
 */
export class MockServer {
  to(_room: string) {
    return {
      emit(_event: string, ..._args: any[]) {
        // no-op
      },
    };
  }
  emit(_event: string, ..._args: any[]) {
    // no-op
  }
  on(_event: string, _handler: any) {
    // no-op
  }
  close() {
    // no-op
  }
}
