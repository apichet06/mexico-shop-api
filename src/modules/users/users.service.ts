import { pool } from "../../db/pool.js";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { CreateUserInput, UpdateUserInput, UserDTO } from "./users.type.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { UserMessages } from "../../shared/messages/user.messages.js";
import { CommonMessages } from "../../shared/messages/index.js";

type UserRow = RowDataPacket & {
    u_id: number;
    u_username: string;
    u_email: string;
    u_birthday: string | null;
    u_gender: string | null;
    u_address: string | null;
    u_image_url: string | null;
    u_create_at: string;
    u_update_at: string | null;
};

function toDTO(r: UserRow): UserDTO {
    return {
        id: r.u_id,
        username: r.u_username,
        email: r.u_email,
        birthday: r.u_birthday,
        gender: r.u_gender,
        address: r.u_address,
        imageUrl: r.u_image_url,
        createdAt: r.u_create_at,
        updatedAt: r.u_update_at,
    };
}



export async function listUsers(): Promise<UserDTO[]> {
    const [rows] = await pool.query<UserRow[]>(
        `SELECT u_id, u_username, u_email, u_birthday, u_gender, u_address, u_image_url, u_create_at, u_update_at
     FROM Users
     ORDER BY u_id DESC
     LIMIT 50`
    );
    return rows.map(toDTO);
}

export async function getUserById(id: number): Promise<UserDTO> {
    const [rows] = await pool.query<UserRow[]>(
        `SELECT u_id, u_username, u_email, u_birthday, u_gender, u_address, u_image_url, u_create_at, u_update_at
     FROM Users
     WHERE u_id = ?`,
        [id]
    );

    const user = rows[0];
    if (!user) throw new ApiError(404, UserMessages.notFound);
    return toDTO(user);
}

export async function createUser(input: CreateUserInput): Promise<UserDTO> {
    const data = {
        u_username: input.username,
        u_email: input.email,
        u_password: input.password ?? null,
        u_provider: input.provider ?? (input.password ? "local" : "google"),
        u_provider_id: input.providerId ?? null,
        u_birthday: input.birthday ?? null,
        u_gender: input.gender ?? null,
        u_address: input.address ?? null,
        u_image_url: input.imageUrl ?? null
    };

    try {
        const [res] = await pool.query<ResultSetHeader>("INSERT INTO Users SET ?", data);

        return await getUserById(res.insertId);
    } catch (err: any) {
        if (isDupError(err)) {
            throw new ApiError(409, UserMessages.repeatEmail);
        }
        throw err;
    }
}

export async function updateUser(id: number, input: UpdateUserInput): Promise<UserDTO> {

    const data = {
        u_username: input.username,
        u_email: input.email,
        u_birthday: input.birthday,
        u_gender: input.gender,
        u_address: input.address,
        u_image_url: input.imageUrl,
        u_update_at: new Date(),
    };

    try {
        const [res] = await pool.query<ResultSetHeader>(
            "UPDATE Users SET ? WHERE u_id = ?",
            [data, id]
        );
        if (res.affectedRows === 0) {
            throw new ApiError(404, UserMessages.notFound);
        }
        return await getUserById(id);
    } catch (err: any) {
        if (isDupError(err)) throw new ApiError(409, UserMessages.repeatEmail);
        throw err;
    }
}

export async function deleteUser(id: number): Promise<{ deleted: true }> {
    try {
        const [res] = await pool.query<ResultSetHeader>(
            "DELETE FROM Users WHERE u_id = ?", [id]
        );
        if (res.affectedRows === 0) {
            throw new ApiError(404, UserMessages.notFound);
        }

        return { deleted: true };
    } catch (err: any) {
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    }
}

