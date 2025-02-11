import net from 'net';
import { Transform } from 'stream';

type ProxyLog = {
    domainName: string,
    bytesProcessed: number
}
interface LogStore {
    save(log: ProxyLog)
    getLogs(): Array<ProxyLog>
}

const PORT = process.env.PORT;
if (!PORT) {
    console.error(`Missing required environment variable PORT`);
    process.exit(1); 
}
const USERNAME = process.env.API_USERNAME;
const PASSWORD = process.env.API_PASSWORD;
if (!USERNAME || !PASSWORD) {
    console.error(`Missing required environment variable API_USERNAME OR API_PASSWORD`);
    process.exit(1); 
}

export class InMemoryStore implements LogStore {
    private logs: ProxyLog[] = []

    public save(log: ProxyLog) {
        this.logs.push(log)
    }

    public getLogs(): Array<ProxyLog> {
        return this.logs
    }
}

const LogsStore = new InMemoryStore()

export const processStats = (logs) => {
    let totalBytes = 0;
    const visits = {} as { url: number };

    logs.forEach(entry => {
        totalBytes += entry.bytesProcessed;
        // Increment the visit count for the domain
        visits[entry.domainName] = (visits[entry.domainName] || 0) + 1;
    });

    // Convert total bytes to MB
    const bandwidthUsage = (totalBytes / (1024 * 1024)).toFixed(2) + 'MB';

    const logStats = {
        bandwidth_usage: bandwidthUsage,
        top_sites: Object.entries(visits).map(([url, visitsCount]) => ({
          url,
          visits: visitsCount
        }))
        .sort((a, b) => b.visits - a.visits)
        .slice(0, 2)
    };
    return logStats      
}

const basicAuthMiddleware = (authHeader) => {
    if (!authHeader) return false;

    const base64Credentials = authHeader.split(' ')[1]; // Extract base64 credentials
    if (!base64Credentials) return false;

    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8'); // Decode base64 to username:password
    const [username, password] = credentials.split(':');

    return username === USERNAME && password === PASSWORD;
};

export class ByteTrackerStream extends Transform {
    byteCount: number;
    constructor() {
      super();
      this.byteCount = 0; 
    }
  
    _transform(chunk, encoding, callback) {
      this.byteCount += chunk.length; 
      this.push(chunk); 
      callback();
    }
}
  

const server = net.createServer((clientToProxySocket) => {
  handleConnection(clientToProxySocket);
});

export const handleConnection = async (clientToProxySocket) => {  
  clientToProxySocket.once('data', async (data) => {
    const requestStr = data.toString();

    // If the request is for /metrics, respond with stats
    if (requestStr.indexOf('GET /metrics') === 0) {
        const stats = processStats(LogsStore.getLogs());
        clientToProxySocket.write('HTTP/1.1 200 OK\r\n');
        clientToProxySocket.write('Content-Type: application/json\r\n\r\n');
        clientToProxySocket.end(JSON.stringify(stats));
        return;
    }

    let isTLSConnection = data.toString().indexOf('CONNECT') !== -1;

    let serverPort = 80;
    let serverAddress;

    if (isTLSConnection) {
      serverPort = 443;
      serverAddress = data.toString()
        .split('CONNECT ')[1]
        .split(' ')[0]
        .split(':')[0];
    } else {
      // For HTTP, extract the host from the HTTP headers
      serverAddress = data.toString()
        .split('Host: ')[1].split('\r\n')[0];
    }

    // do a proxy basic authentication to allow access
    const authHeader = data.toString().match(/Proxy-Authorization: (.*)\r\n/);
    if (authHeader && !basicAuthMiddleware(authHeader[1])) {
      clientToProxySocket.write('HTTP/1.1 401 Authentication Required\r\n');
      clientToProxySocket.write('Content-Type: text/html \r\n\r\n')
      clientToProxySocket.end('Authentication Required')
      return;
    }

    try {
      // Create a connection to the server
      const proxyToServerSocket = net.createConnection({
        host: serverAddress,
        port: serverPort
      });

      console.log('PROXY reached the target SERVER');
      
      // For TLS connection, send 200 OK to confirm the tunnel
      if (isTLSConnection) {
        clientToProxySocket.write('HTTP/1.1 200 OK\r\n\n');
      } else {
        // If HTTP, forward the original data
        proxyToServerSocket.write(data);
      }

      const byteTrackerStream = new ByteTrackerStream();

      // Piping the data between client and server
      clientToProxySocket.pipe(proxyToServerSocket);
      proxyToServerSocket.pipe(byteTrackerStream).pipe(clientToProxySocket);


      byteTrackerStream.on('end', () => {
        // log the request and the bandwith usage
        let urlServerAddr = new URL(!serverAddress.startsWith('http://') && !serverAddress.startsWith('https://') ? `http://${serverAddress}`: serverAddress).hostname
        if (urlServerAddr.startsWith('www')){
            // just split the first www away
            urlServerAddr = urlServerAddr.split('www.')[1]
        }
        // store the logs for metrics
        LogsStore.save({ domainName: urlServerAddr, bytesProcessed: byteTrackerStream.byteCount });
      });

      // Handle proxy-to-server errors
      proxyToServerSocket.on('error', (err) => {
        console.log('PROXY TO SERVER ERROR');
        console.log(err);
      });

      // Handle client-to-proxy errors
      clientToProxySocket.on('error', (err) => {
        console.log('CLIENT TO PROXY ERROR');
        console.log(err);
      });
      
    } catch (error) {
      console.error('Error handling connection:', error);
      clientToProxySocket.end('HTTP/1.1 500 Internal Server Error\r\n');
    }
  });
};

// Server error handling
server.on('error', (err) => {
  console.log('SERVER ERROR');
  console.log(err);
});

// Handle closing connection
server.on('close', () => {
  console.log('Client Disconnected');
});

server.listen(parseInt(PORT), () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
    console.log('Process terminated, shutting down server...');
    console.log(processStats(LogsStore.getLogs()))
    // should do db disconnection if you are not using in memory storage
    console.log("closing server")
    process.exit(0);
});