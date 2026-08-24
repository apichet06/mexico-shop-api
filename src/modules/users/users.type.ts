export type UserDTO = {
    id: number;
    username: string;
    email: string;
    birthday: string | null;
    gender: string | null;
    address: string | null;
    imageUrl: string | null;
    createdAt: string;
    updatedAt: string | null;
};

export type CreateUserInput = {
    username: string;
    email: string;
    password?: string | null;
    provider?: "local" | "google";
    providerId?: string | null;
    birthday?: string | null;
    gender?: string | null;
    address?: string | null;
    imageUrl?: string | null;
};

export type UpdateUserInput = {
    username: string;
    email: string;
    birthday: string | null;
    gender: string | null;
    address: string | null;
    imageUrl: string | null;
};