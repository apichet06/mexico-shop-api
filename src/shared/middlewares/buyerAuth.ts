import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AuthMessages } from "../messages/auth.messages.js";
import { CommonMessages } from "../messages/common.messages.js";

export function BuyerAuth(req: Request, res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer "))
            return res.status(401).json({ status: CommonMessages.error, message: AuthMessages.notToken });

        const token = authHeader.split(" ")[1] as string;
        const secret = process.env.JWT_SECRET;

        if (!secret)
            return res.status(500).json({ status: CommonMessages.error, message: AuthMessages.secret });

        const decoded = jwt.verify(token, secret) as any;
        req.userId = decoded.userId;

        next();
    } catch (err) {
        if (err instanceof jwt.TokenExpiredError)
            return res.status(401).json({ status: CommonMessages.error, message: AuthMessages.expiredToken });

        return res.status(401).json({ status: CommonMessages.error, message: AuthMessages.invalidToken });
    }
}

export function OptionalBuyerAuth(req: Request, _res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            next();
            return;
        }

        const token = authHeader.split(" ")[1] as string;
        const secret = process.env.JWT_SECRET;

        if (!secret) {
            next();
            return;
        }

        const decoded = jwt.verify(token, secret) as any;
        req.userId = decoded.userId;
    } catch {
        // This endpoint is public; invalid buyer tokens simply mean "anonymous".
    }

    next();
}
