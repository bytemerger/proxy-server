import { describe, it, expect, mock, jest } from 'bun:test';
import net from 'net';
import { handleConnection, InMemoryStore } from './index.ts';

// Mocking basicAuthMiddleware
const basicAuthMiddleware = mock(() => true );

// Mocking the LogsStore to mock save and getLogs methods
const mockSave = mock();
const mockGetLogs = mock(() => ([
  { domainName: 'example.com', bytesProcessed: 200 },
]));

const LogsStore = new InMemoryStore()
LogsStore.save = mockSave;
LogsStore.getLogs = mockGetLogs;



describe('Proxy Server Tests', () => {

  it('should respond with metrics data when /metrics is requested', async () => {
    const data = Buffer.from('GET /metrics HTTP/1.1\r\nHost: localhost\r\n\r\n');

    // Mocking clientToProxySocket
    const clientToProxySocket = {
      once: jest.fn(),
      write: mock(),
      pipe: mock(),
      end: mock(),
    };

    // Mock the 'data' event to simulate a request to /metrics
    clientToProxySocket.once.mockImplementation((event, callback) => {
      if (event === 'data') {
        callback(data); // Trigger the data callback
      }
    });

    mock.module("./index.ts", () => {
      return {
        processStats: jest.fn().mockReturnValue({
          bandwidth_usage: '0.19MB',
          top_sites: [
            { url: 'example.com', visits: 1 }
          ]
        }),
      };
    });

    await handleConnection(clientToProxySocket);

    // Check if the client received a response with the metrics data
    expect(clientToProxySocket.write).toHaveBeenCalledWith('HTTP/1.1 200 OK\r\n');
    expect(clientToProxySocket.write).toHaveBeenCalledWith('Content-Type: application/json\r\n\r\n');
    expect(clientToProxySocket.end).toHaveBeenCalledWith(JSON.stringify({
      bandwidth_usage: '0.19MB',
      top_sites: [
        { url: 'example.com', visits: 1 }
      ]
    }));
  });

  it('should reject with 401 if proxy auth is invalid', async () => {
    const invalidAuthData = Buffer.from('GET / HTTP/1.1\r\nProxy-Authorization: Basic invalid\r\nHost: localhost\r\n\r\n');

    const clientToProxySocket = {
      once: jest.fn(),
      write: mock(),
      pipe: mock(),
      end: mock(),
    };
    
    clientToProxySocket.once.mockImplementation((event, callback) => {
      if (event === 'data') {
        callback(invalidAuthData);
      }
    });
    
    basicAuthMiddleware.mockReturnValueOnce(false);

    await handleConnection(clientToProxySocket);

    expect(clientToProxySocket.write).toHaveBeenCalledWith('HTTP/1.1 401 Authentication Required\r\n');
    expect(clientToProxySocket.end).toHaveBeenCalledWith('Authentication Required');
  });

  it('should forward data to the server and log bandwidth usage', async () => {
    const data = Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');

    const clientToProxySocket = {
      once: jest.fn(),
      write: mock(),
      pipe: jest.fn(),
      on: jest.fn(),
      end: mock(),
    };

    const proxyToServerSocket = {
      write: jest.fn(),
      on: mock(),
      pipe: jest.fn(),
    };

    const byteTrackerStream = {
      byteCount: 200,
      on: jest.fn().mockImplementation((event, callback) => {
            if (event === 'end') {
              callback();
          }}),
      pipe: jest.fn()
    };

    clientToProxySocket.once.mockImplementation((event, callback) => {
      if (event === 'data') {
        callback(data);
      }
    });

    // Mock the network connection logic
    net.createConnection = jest.fn().mockReturnValue(proxyToServerSocket);

    proxyToServerSocket.pipe = jest.fn().mockReturnValue(byteTrackerStream);

    await handleConnection(clientToProxySocket);

    expect(proxyToServerSocket.write).toHaveBeenCalledWith(data);
  });
});

