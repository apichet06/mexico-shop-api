export type StoreRegistrationMember = {
    firstName?: string | null;
    lastName?: string | null;
    email: string;
    phone?: string | null;
    role: string;
};

export type StoreRegistrationEmailInput = {
    storeId: number;
    storeNumber: string;
    storeName: string;
    storeEmail: string;
    storePhone?: string | null;
    status: string;
    members: StoreRegistrationMember[];
};

export type PasswordResetEmailInput = {
    email: string;
    name?: string | null;
    resetUrl: string;
    expiresInMinutes: number;
};

export type SellerConfirmationEmailInput = {
    email: string;
    storeName: string;
    confirmUrl: string;
    expiresAt: Date;
};

export type StoreEmailVerificationEmailInput = {
    email: string;
    storeName: string;
    verifyUrl: string;
    expiresAt: Date;
};

export type EmployeeEmailVerificationEmailInput = {
    email: string;
    name?: string | null;
    storeName?: string | null;
    role?: string | null;
    verifyUrl: string;
    expiresAt: Date;
};

export type MailConfig = {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    fromName: string;
    fromEmail: string;
};
