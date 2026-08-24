export type StoreStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | "UPLOAD" | "REQUEST" | "PENDING_SELLER_CONFIRMATION";

export function mapStatusToType(status: string) {
    const map: Record<string, string> = {
        PENDING: "PENDING",
        PENDING_SELLER_CONFIRMATION: "PENDING_SELLER_CONFIRMATION",
        ACTIVE: 'ACTIVE',
        SUSPENDED: 'SUSPENDED',
        REJECTED: 'REJECTED',
        UPLOAD: 'UPLOAD',
        REQUEST: 'REQUEST'
    }
    return map[status]
}

export function mapStatusToAction(status: string) {
    const map: Record<string, string> = {
        PENDING: 'ส่งคำขอเปิดร้าน',
        PENDING_SELLER_CONFIRMATION: 'รอผู้ฝากขายยืนยันข้อมูลและ PDPA',
        ACTIVE: 'อนุมัติ พร้อมใช้งาน',
        REJECTED: 'ตีกลับคำขอ',
        REQUEST_MORE: 'ขอเอกสารเพิ่มเติม',
        UPLOAD: 'ส่งเอกสาร รอตรวจสอบ',
        SUSPENDED: 'ระงับการใช้งาน'
    }

    return map[status] ?? status
}

export function mapDocumetType(doc_type: string) {
    const map: Record<string, string> = {
        VAT_CERT: 'ใบทะเบียนภาษีมูลค่าเพิ่ม ภ.พ.20',
        COMPANY_CERT: 'หนังสือรับรองบริษัท',
        ID_CARD: 'สำเนาบัตรประชาชน',
        OTHER: 'อื่นๆ'
    }
    return map[doc_type]
}

export type StoreLogDTO = {
    stl_id: number
    stl_type: string
    stl_actor: string
    stl_action: string
    stl_node: string
    stl_timestamp: string
    st_id: number
}

export type StoreDTO = {
    st_id: number;
    st_number: string;
    st_company_name: string;
    st_idcard: string;
    bank_account_number: string;
    omise_recipient_id: string | null;
    st_email: string;
    st_email_verified_at?: string | Date | null;
    created_at: string;
    st_phone: string;
    st_image: string;
    st_status: StoreStatus;
    st_note: string | null;
    is_platform_store: boolean | 0 | 1 | "0" | "1";
    e_id: number;
    bk_id: number;
    bk_name: string;
    account_name: string | null;
    updated_at: string | null;
}

// types/store.shared.ts

export type SellerType = "INDIVIDUAL" | "JURISTIC";
export type BranchType = "HEAD_OFFICE" | "BRANCH";
export type EmployeeStatus = "SuperAdmin" | "Admin" | "Owner" | "Staff";
export type DocumentType = "VAT_CERT" | "COMPANY_CERT" | "ID_CARD" | "OTHER";

export interface StoreLocationInput {
    loc_name: string;
    loc_address: string;
    loc_province_id: number;
    loc_district_id: number;
    loc_subdistrict_id: number;
    loc_zip_code: string;
    is_default: boolean;
}

export interface StoreEmployeeInput {
    e_firstname: string;
    e_lastname: string;
    e_email: string;
    e_phone: string;
    e_status: EmployeeStatus;
    e_password: string; // รหัสผ่านที่ถูก hash มาแล้วจาก controller
}

export interface StoreTaxProfileDTO {
    legal_name: string;
    is_vat_registered: boolean;
    branch_type: BranchType;
    branch_code: string;
    tax_address: string;
    tax_id_number: string,
    tax_province_id: number;
    tax_district_id: number;
    tax_subdistrict_id: number;
    tax_seller_type: SellerType;
    tax_zip_code: string;
}

export interface StoreDetailDTO {
    store: StoreDTO
    tax: StoreTaxProfileDTO | null
    documents: StoreDocumentBackend[]
}



export interface StoreDocumentBackend {
    doc_type: DocumentType;
    files?: Express.Multer.File[];
}
export interface CreateStoreRegisterInput {

    st_company_name: string;
    st_idcard: string;
    bank_account_number: string;
    st_email: string;
    st_phone: string;
    st_image: string | null;
    st_id: number; // ได้มาจาก token
    bk_id: number;
    tax_seller_type: SellerType;
    st_status: string;
    is_platform_store?: boolean;
    requires_seller_confirmation?: boolean;


    legal_name: string;
    tax_id_number: string;
    is_vat_registered: boolean;

    branch_type: BranchType;
    branch_code: string;

    tax_address: string;
    tax_province_id: number;
    tax_district_id: number;
    tax_subdistrict_id: number;
    tax_zip_code: string;

    locations: StoreLocationInput[];
    employees: StoreEmployeeInput[];
    documents?: StoreDocumentBackend[];
}

export interface UpdateStoreRegisterInput extends Partial<Omit<CreateStoreRegisterInput, 'st_id'>> {
    st_id: number;
    updated_at: string;
}


export type CreateStoreInput = {
    st_company_name: string;
    bank_account_number: string;
    st_email: string;
    st_phone: string;
    st_image: string | null;
    bk_id: number;
}

export type UpdateStoreInput = {
    st_company_name: string;
    bank_account_number: string;
    omise_recipient_id?: string | null;
    st_email: string;
    st_phone: string;
    st_image: string | undefined;
    bk_id: number;
}


export type BankDTO = {
    bk_id: number;
    bk_name: string;
}


export type StoreShopDTO = {
    st_id: number;
    st_company_name: string;
    st_phone: string;
    st_image: string;
    st_email: string;
}
