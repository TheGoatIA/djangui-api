import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';

export interface RequestStore {
  requestId: string;
  userId?: string;
  [key: string]: any;
}

class RequestContext {
  private static storage = new AsyncLocalStorage<RequestStore>();

  /**
   * Run a function within a new request context
   */
  static run(store: Partial<RequestStore>, fn: () => void | Promise<void>) {
    const fullStore: RequestStore = {
      requestId: store.requestId || uuidv4(),
      ...store,
    };
    return this.storage.run(fullStore, fn);
  }

  /**
   * Get the current context store
   */
  static getStore(): RequestStore | undefined {
    return this.storage.getStore();
  }

  /**
   * Set a value in the current context
   */
  static set(key: keyof RequestStore, value: any) {
    const store = this.getStore();
    if (store) {
      store[key] = value;
    }
  }

  /**
   * Get a specific value from the context
   */
  static get(key: keyof RequestStore): any {
    return this.getStore()?.[key];
  }

  /**
   * Get the current requestId
   */
  static getRequestId(): string | undefined {
    return this.get('requestId');
  }

  /**
   * Get the current userId
   */
  static getUserId(): string | undefined {
    return this.get('userId');
  }
}

export default RequestContext;
