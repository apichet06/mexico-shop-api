import { Server } from "socket.io";
import type { Server as HttpServer } from "http";

let io: Server | null = null;

const allowedOrigins = [
    "http://localhost:3000",
    "https://localhost:3000",
    "http://localhost:3001",
    "https://localhost:3001",
    "https://arcanabackoffice.dev.system-samt.com",
    "https://arcana-shop.dev.system-samt.com",
];

export function initSocket(httpServer: HttpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: allowedOrigins,
            methods: ["GET", "POST"],
            credentials: true,
        },
        // websocket: ใช้กับ Flutter mobile ผ่าน socket_io_client เพื่อให้ chat/notification realtime
        // polling: ใช้กับเว็บ Next.js/backoffice เดิมที่ตั้ง socket.io-client เป็น transports: ["polling"]
        transports: ["websocket", "polling"],
        pingTimeout: 60000,
        pingInterval: 25000,
    });

    io.on("connection", (socket) => {
        console.log("socket connected:", socket.id);

        socket.on("join_user", (userId: number) => {
            socket.join(`USER_${userId}`);
            console.log(`USER_${userId} joined`);
        });

        socket.on("join_store", (storeId: number) => {
            socket.join(`STORE_${storeId}`);
            console.log(`STORE_${storeId} joined`);
        });

        socket.on("join_conversation", ({ conv_id }: { conv_id: number }) => {
            socket.join(`CONV_${conv_id}`);
            console.log(`CONV_${conv_id} joined`);
        });

        socket.on("disconnect", () => {
            console.log("socket disconnected:", socket.id);
        });
    });

    return io;
}

export function getIO() {
    if (!io) {
        throw new Error("Socket.IO not initialized");
    }
    return io;
}
