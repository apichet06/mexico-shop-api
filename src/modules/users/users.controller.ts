import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as users from "./users.service.js";
import { UserMessages } from "../../shared/messages/user.messages.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";

export const list = asyncHandler(async (_req, res) => {
    const data = await users.listUsers();
    res.json({ data });
});

export const getById = asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw new ApiError(400, CommonMessages.invalidId);
    const data = await users.getUserById(id);
    res.json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const { username, email, password, birthday, gender, address, imageUrl } = req.body ?? {};
    if (!username || !email) {
        throw new ApiError(400, UserMessages.requiredFields);
    }
    const data = await users.createUser({ username, email, password, birthday, gender, address, imageUrl });
    res.status(201).json({ data });
});

export const update = asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw new ApiError(400, CommonMessages.invalidId);

    const { username, email, birthday, gender, address, imageUrl } = req.body ?? {};
    if (!username || !email) {
        throw new ApiError(400, UserMessages.requiredFields);
    }

    const data = await users.updateUser(id, {
        username,
        email,
        birthday: birthday ?? null,
        gender: gender ?? null,
        address: address ?? null,
        imageUrl: imageUrl ?? null,
    });

    res.json({ data });
});

export const remove = asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw new ApiError(400, CommonMessages.invalidId);
    const data = await users.deleteUser(id);
    res.json({ data });
});
