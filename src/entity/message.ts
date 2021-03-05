import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class MessageRelation {
    @PrimaryGeneratedColumn()
    id: number

    @Column()
    discord: string

    @Column()
    onebot: string

    @Column("text")
    message: string;
}