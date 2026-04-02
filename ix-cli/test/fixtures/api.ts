import axios from "axios";
import { Config } from "./config";

interface UserResponse {
  id: string;
  name: string;
  email: string;
}

export class ApiClient {
  private baseUrl: string;

  constructor(private config: Config) {
    this.baseUrl = config.baseUrl;
  }

  async getUser(userId: string): Promise<UserResponse> {
    const response = await axios.get(`${this.baseUrl}/users/${userId}`);
    return this.parseResponse(response);
  }

  async updateUser(userId: string, data: Partial<UserResponse>): Promise<UserResponse> {
    const response = await axios.put(`${this.baseUrl}/users/${userId}`, data);
    return this.parseResponse(response);
  }

  private parseResponse(response: any): UserResponse {
    return response.data as UserResponse;
  }
}

export function createClient(config: Config): ApiClient {
  return new ApiClient(config);
}

export async function fetchAllUsers(client: ApiClient): Promise<UserResponse[]> {
  const response = await client.getUser("all");
  return [response];
}
